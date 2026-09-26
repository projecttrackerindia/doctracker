// ============================================================================
// Observability time-series store.
//
// This is the read/write layer for the two tables that replaced the single
// encrypted `endpoint_metrics_enc` blob as the home for traffic data (see the
// long note above their CREATE TABLE in server/db.js for why the blob could
// not do this job).
//
// Three tiers, deliberately:
//
//   endpoint_metrics_rollup         1-minute buckets, ~30 days. EXACT counts -
//                                   every request counted, nothing evicted.
//
//   endpoint_metrics_rollup_hourly  the same counters folded to the hour once
//                                   minute rows age out, kept ~400 days. Still
//                                   exact: folding sums, it does not sample.
//                                   Without this, a year of 1-minute rows runs
//                                   to tens of GB at production volume, held at
//                                   a resolution no chart can draw.
//
//   endpoint_log_records            individual requests, 7-day retention, daily
//                                   partitions. Only populated under
//                                   CAPTURE_MODE=full. For drill-down ("show me
//                                   the actual failing calls"), never for
//                                   aggregates.
//
// The two rollup tiers are DISJOINT - the downsample deletes the minute rows
// it folds, in the same transaction - so reads UNION them (see ROLLUP_SOURCE)
// with no de-duplication and no risk of double counting.
//
// The important consequence: a month of accurate, date-filtered metrics needs
// ONLY the rollup tier, which contains no captured field values at all. Full
// capture buys per-request drill-down and nothing else, so its privacy cost is
// now scoped to a 7-day window instead of being the price of having history.
// ============================================================================
const { pool } = require('./db');
const dataCrypto = require('./crypto');
const obsCache = require('./obsCache');

// Prometheus-style cumulative-friendly boundaries, in milliseconds. Stored per
// rollup bucket as {"10": n, "25": n, ..., "inf": n} where n is the count of
// requests whose latency fell IN that band (not cumulative - see
// percentileFromBuckets, which accumulates at read time).
//
// Why a histogram rather than storing p50/p95/p99 per bucket: percentiles are
// not averageable. Taking the mean of sixty one-minute p95s does not give the
// hour's p95 and can be wildly wrong. Summing histogram bands across any
// number of buckets and reading the percentile off the total IS correct, which
// is what makes "p95 over the last 30 days" a meaningful number here.
const LATENCY_BUCKET_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const LATENCY_BUCKET_KEYS = LATENCY_BUCKET_BOUNDS.map(String).concat(['inf']);

function latencyBucketKey(ms) {
  for (const bound of LATENCY_BUCKET_BOUNDS) {
    if (ms <= bound) return String(bound);
  }
  return 'inf';
}

// Reads a percentile off summed histogram bands with linear interpolation
// inside the band the target falls in - the same estimator Prometheus'
// histogram_quantile uses, so a single sample in the (100, 250] band reports
// 175ms rather than either edge. The result is always inside the band the
// value actually fell in, which is the accuracy guarantee a histogram can
// honestly make; it is an estimate within a known interval, not a precise
// figure, and the band widths above set how tight that interval is.
//
// Returns null rather than 0 when there is nothing to measure - a p95 of
// "0ms" on an endpoint with no traffic reads as a real, excellent number,
// which is exactly the kind of confident-looking wrong figure this codebase
// avoids elsewhere.
function percentileFromBuckets(buckets, q) {
  const counts = LATENCY_BUCKET_KEYS.map((k) => Number(buckets?.[k] || 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;

  const target = total * q;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const next = cumulative + counts[i];
    if (next >= target) {
      const lower = i === 0 ? 0 : LATENCY_BUCKET_BOUNDS[i - 1];
      // The open-ended top band has no upper bound to interpolate toward, so
      // report its lower edge rather than inventing a ceiling.
      const upper = LATENCY_BUCKET_KEYS[i] === 'inf' ? lower : LATENCY_BUCKET_BOUNDS[i];
      if (upper === lower || counts[i] === 0) return Math.round(upper);
      const within = (target - cumulative) / counts[i];
      return Math.round(lower + (upper - lower) * within);
    }
    cumulative = next;
  }
  return Math.round(LATENCY_BUCKET_BOUNDS[LATENCY_BUCKET_BOUNDS.length - 1]);
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

// Postgres's wire protocol counts bind parameters in a 16-bit field, so a
// single statement can carry at most 65,535 of them. Exceeding it does not
// raise a clean "too many parameters" error - the counter WRAPS, and the
// server reports a nonsensical mismatch ("bind message has 14464 parameter
// formats but 0 parameters"), which is close to undebuggable from the agent
// side.
//
// So inserts are CHUNKED to stay well inside the limit rather than capped at
// a number that happens to fit. Capping would silently discard buckets on a
// busy interval, which is the one thing the exact-count tier must never do.
// The agent can legitimately send far more than one chunk's worth after any
// push outage (it holds up to MAX_PENDING_ROLLUP_BUCKETS).
const ROLLUP_PARAMS_PER_ROW = 16;
const RECORD_PARAMS_PER_ROW = 11;
const ROLLUP_CHUNK_ROWS = 1000; // 16,000 params - comfortable margin
const RECORD_CHUNK_ROWS = 1000; // 11,000 params

// Outer ceilings, so a runaway or malicious client cannot make the server
// loop forever. Far above anything the agent produces in practice.
const MAX_BUCKETS_PER_PUSH = 50000;
const MAX_RECORDS_PER_PUSH = 50000;

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function addCounters(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    into[k] = (into[k] || 0) + Number(v || 0);
  }
  return into;
}

// Collapses buckets that share a (endpoint, minute) key BEFORE they reach the
// INSERT.
//
// Postgres refuses to let one ON CONFLICT DO UPDATE statement touch the same
// row twice - it aborts the whole statement with "ON CONFLICT DO UPDATE
// command cannot affect row a second time". So a single push containing two
// buckets for the same endpoint-minute would 500 the entire request, losing
// every other bucket in it too.
//
// The agent cannot currently produce such a pair (it accumulates into a dict
// keyed by exactly this pair), but relying on that is fragile: chunking makes
// the failure depend on whether the duplicates happen to land in the same
// batch, and "add both" is the obviously correct reading of the request
// anyway. Summing here makes ingest order-independent and duplicate-proof.
function collapseDuplicateBuckets(buckets) {
  const byKey = new Map();
  for (const b of buckets) {
    const key = String(b.endpointId) + '|' + String(b.bucketStart);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, Object.assign({}, b, {
        latencyBuckets: Object.assign({}, b.latencyBuckets || {}),
        sourceIps: Object.assign({}, b.sourceIps || {}),
      }));
      continue;
    }
    seen.requestCount = toInt(seen.requestCount) + toInt(b.requestCount);
    seen.status2xx = toInt(seen.status2xx) + toInt(b.status2xx);
    seen.status3xx = toInt(seen.status3xx) + toInt(b.status3xx);
    seen.status4xx = toInt(seen.status4xx) + toInt(b.status4xx);
    seen.status5xx = toInt(seen.status5xx) + toInt(b.status5xx);
    seen.statusUnknown = toInt(seen.statusUnknown) + toInt(b.statusUnknown);
    seen.latencySum = toInt(seen.latencySum) + toInt(b.latencySum);
    seen.latencyCount = toInt(seen.latencyCount) + toInt(b.latencyCount);
    if (isFiniteNum(b.latencyMin)) {
      seen.latencyMin = isFiniteNum(seen.latencyMin) ? Math.min(seen.latencyMin, b.latencyMin) : b.latencyMin;
    }
    if (isFiniteNum(b.latencyMax)) {
      seen.latencyMax = isFiniteNum(seen.latencyMax) ? Math.max(seen.latencyMax, b.latencyMax) : b.latencyMax;
    }
    addCounters(seen.latencyBuckets, b.latencyBuckets);
    addCounters(seen.sourceIps, b.sourceIps);
  }
  return [...byKey.values()];
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toInt(v, fallback = 0) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

// Upserts 1-minute rollup buckets, summing into whatever is already stored for
// the same (org, environment, endpoint, minute).
//
// This is the write path's whole point: it is a single statement, it never
// reads before writing, and concurrent agents touching the same bucket sum
// correctly rather than overwriting each other. There is no row lock to
// contend on and no ciphertext to round-trip, which is what makes a 60-second
// (or faster) push cadence cheap enough to stop thinking about.
async function ingestRollups(organisation, environment, buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return { written: 0 };
  // Collapse duplicates first - see collapseDuplicateBuckets(). Doing this
  // before the cap also means a push full of duplicates is not counted
  // against the ceiling twice.
  const capped = collapseDuplicateBuckets(buckets).slice(0, MAX_BUCKETS_PER_PUSH);

  const chunks = chunk(capped, ROLLUP_CHUNK_ROWS);
  if (chunks.length === 1) {
    return { written: await ingestRollupChunk(organisation, environment, chunks[0], pool) };
  }

  // ATOMIC across chunks, deliberately. The agent only clears its pending
  // buckets after a successful push and retries the whole set otherwise - so
  // if chunk 1 committed and chunk 2 failed, the retry would add chunk 1's
  // counts A SECOND time. Because the upsert sums rather than replaces, that
  // double-count would be permanent and invisible. All-or-nothing makes the
  // retry safe.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let written = 0;
    for (const part of chunks) {
      written += await ingestRollupChunk(organisation, environment, part, client);
    }
    await client.query('COMMIT');
    return { written };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ingestRollupChunk(organisation, environment, capped, runner) {
  const values = [];
  const params = [];
  let i = 1;
  for (const b of capped) {
    const endpointId = typeof b.endpointId === 'string' ? b.endpointId.slice(0, 64) : '';
    const bucketStart = typeof b.bucketStart === 'string' ? b.bucketStart : null;
    if (!endpointId || !bucketStart || Number.isNaN(Date.parse(bucketStart))) continue;

    values.push(
      `($${i}, $${i + 1}, $${i + 2}, $${i + 3}::timestamptz, $${i + 4}, $${i + 5}, $${i + 6}, ` +
      `$${i + 7}, $${i + 8}, $${i + 9}, $${i + 10}, $${i + 11}, $${i + 12}, $${i + 13}, ` +
      `$${i + 14}::jsonb, $${i + 15}::jsonb)`
    );
    params.push(
      organisation,
      environment,
      endpointId,
      bucketStart,
      toInt(b.requestCount),
      toInt(b.status2xx),
      toInt(b.status3xx),
      toInt(b.status4xx),
      toInt(b.status5xx),
      toInt(b.statusUnknown),
      toInt(b.latencySum),
      toInt(b.latencyCount),
      isFiniteNum(b.latencyMin) ? toInt(b.latencyMin) : null,
      isFiniteNum(b.latencyMax) ? toInt(b.latencyMax) : null,
      JSON.stringify(b.latencyBuckets && typeof b.latencyBuckets === 'object' ? b.latencyBuckets : {}),
      JSON.stringify(b.sourceIps && typeof b.sourceIps === 'object' ? b.sourceIps : {})
    );
    i += ROLLUP_PARAMS_PER_ROW;
  }
  if (!values.length) return 0;

  await runner.query(
    `INSERT INTO endpoint_metrics_rollup (
       organisation, environment, endpoint_id, bucket_start,
       request_count, status_2xx, status_3xx, status_4xx, status_5xx, status_unknown,
       latency_sum, latency_count, latency_min, latency_max, latency_buckets, source_ips
     ) VALUES ${values.join(', ')}
     ON CONFLICT (organisation, environment, endpoint_id, bucket_start) DO UPDATE SET
       request_count  = endpoint_metrics_rollup.request_count  + EXCLUDED.request_count,
       status_2xx     = endpoint_metrics_rollup.status_2xx     + EXCLUDED.status_2xx,
       status_3xx     = endpoint_metrics_rollup.status_3xx     + EXCLUDED.status_3xx,
       status_4xx     = endpoint_metrics_rollup.status_4xx     + EXCLUDED.status_4xx,
       status_5xx     = endpoint_metrics_rollup.status_5xx     + EXCLUDED.status_5xx,
       status_unknown = endpoint_metrics_rollup.status_unknown + EXCLUDED.status_unknown,
       latency_sum    = endpoint_metrics_rollup.latency_sum    + EXCLUDED.latency_sum,
       latency_count  = endpoint_metrics_rollup.latency_count  + EXCLUDED.latency_count,
       latency_min    = LEAST(endpoint_metrics_rollup.latency_min, EXCLUDED.latency_min),
       latency_max    = GREATEST(endpoint_metrics_rollup.latency_max, EXCLUDED.latency_max),
       latency_buckets = jsonb_counter_merge(endpoint_metrics_rollup.latency_buckets, EXCLUDED.latency_buckets),
       source_ips      = jsonb_counter_merge(endpoint_metrics_rollup.source_ips, EXCLUDED.source_ips)`,
    params
  );
  return values.length;
}

// Appends raw per-request records (CAPTURE_MODE=full only). The captured field
// VALUES are encrypted per row before they touch the table; everything else is
// queryable metadata. See the db.js note on why that split is the right one.
async function ingestRecords(organisation, environment, records) {
  if (!Array.isArray(records) || !records.length) return { written: 0 };
  const capped = records.slice(0, MAX_RECORDS_PER_PUSH);

  const chunks = chunk(capped, RECORD_CHUNK_ROWS);
  if (chunks.length === 1) {
    return { written: await ingestRecordChunk(organisation, environment, chunks[0], pool) };
  }
  // Records are an append, so a partially-applied batch would duplicate rows
  // on the agent's retry rather than double-count a counter. Still atomic,
  // for the same reason: the retry has to be safe.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let written = 0;
    for (const part of chunks) {
      written += await ingestRecordChunk(organisation, environment, part, client);
    }
    await client.query('COMMIT');
    return { written };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ingestRecordChunk(organisation, environment, capped, runner) {
  const values = [];
  const params = [];
  let i = 1;
  for (const r of capped) {
    const ts = typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts)) ? r.ts : null;
    const endpointId = typeof r.endpointId === 'string' ? r.endpointId.slice(0, 64) : '';
    if (!ts || !endpointId) continue;

    let fieldsEnc = null;
    let keyVersion = null;
    const fields = {};
    // The method and path travel INSIDE the encrypted payload, never as
    // columns. endpoint_id is a hash precisely so no API surface sits in an
    // indexed plaintext column, and that holds - but a log explorer whose
    // every row reads "auto-ad0a5a390a" cannot be used, and the id resolves
    // to a name only for endpoints the viewer's project list already
    // contains, which a freshly discovered one does not. Carrying the name
    // in the ciphertext costs nothing: the payload is decrypted only for the
    // page actually being returned.
    if (typeof r.method === 'string' && r.method) fields.method = r.method.slice(0, 10).toUpperCase();
    if (typeof r.path === 'string' && r.path) fields.path = r.path.slice(0, 512);
    if (r.requestFields && typeof r.requestFields === 'object') fields.requestFields = r.requestFields;
    if (r.responseFields && typeof r.responseFields === 'object') fields.responseFields = r.responseFields;
    if (Object.keys(fields).length) {
      // AAD-bound to the organisation, same as every other encrypted value in
      // this app - a ciphertext lifted from one org's row cannot be replayed
      // into another's. encryptField() embeds the key version in the token
      // itself; `key_version` is stored alongside purely so a future bulk
      // re-encryption pass can find old rows with an indexed scan instead of
      // parsing every ciphertext.
      fieldsEnc = dataCrypto.encryptField(JSON.stringify(fields), `obs_record:${organisation}`);
      keyVersion = dataCrypto.currentKeyVersion();
    }

    values.push(
      `($${i}, $${i + 1}, $${i + 2}, $${i + 3}::timestamptz, $${i + 4}, $${i + 5}, ` +
      `$${i + 6}, $${i + 7}, $${i + 8}, $${i + 9}, $${i + 10})`
    );
    params.push(
      organisation,
      environment,
      endpointId,
      ts,
      isFiniteNum(r.statusCode) ? toInt(r.statusCode) : null,
      isFiniteNum(r.latencyMs) ? toInt(r.latencyMs) : null,
      typeof r.clientIp === 'string' ? r.clientIp.slice(0, 64) : null,
      typeof r.correlationId === 'string' ? r.correlationId.slice(0, 128) : null,
      typeof r.flowName === 'string' ? r.flowName.slice(0, 200) : null,
      fieldsEnc,
      keyVersion
    );
    i += RECORD_PARAMS_PER_ROW;
  }
  if (!values.length) return 0;

  await runner.query(
    `INSERT INTO endpoint_log_records (
       organisation, environment, endpoint_id, ts,
       status_code, latency_ms, client_ip, correlation_id, flow_name,
       fields_enc, key_version
     ) VALUES ${values.join(', ')}`,
    params
  );
  return values.length;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Reads span BOTH rollup tiers. The downsample job deletes the minute rows it
// folds into hourly ones (in one transaction - see downsampleOldRollups), so
// the two tables never describe the same interval and a plain UNION ALL is
// exactly right: no de-duplication needed, no risk of double counting.
//
// Queries therefore select from this instead of naming a table, which keeps
// "where does the data live" in one place rather than in five query strings.
const ROLLUP_SOURCE = `(
  SELECT organisation, environment, endpoint_id, bucket_start, request_count,
         status_2xx, status_3xx, status_4xx, status_5xx, status_unknown,
         latency_sum, latency_count, latency_min, latency_max, latency_buckets, source_ips
  FROM endpoint_metrics_rollup
  UNION ALL
  SELECT organisation, environment, endpoint_id, bucket_start, request_count,
         status_2xx, status_3xx, status_4xx, status_5xx, status_unknown,
         latency_sum, latency_count, latency_min, latency_max, latency_buckets, source_ips
  FROM endpoint_metrics_rollup_hourly
)`;

// `alias` qualifies the column names for queries that join this table against
// something else (the histogram expansions below). Passing it is cleaner and
// far less fragile than string-rewriting the finished clause.
function whereClause(organisation, environment, from, to, alias = '', endpointIds = null) {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const params = [organisation];
  const parts = [`${col('organisation')} = $1`];
  let i = 2;
  // Scoping to the API or endpoint selected in the sidebar. `= ANY($n)` takes
  // the whole list as ONE parameter, so a project with hundreds of endpoints
  // costs one placeholder rather than hundreds, and the index on
  // (organisation, environment, bucket_start, endpoint_id) still applies.
  if (Array.isArray(endpointIds) && endpointIds.length) {
    parts.push(`${col('endpoint_id')} = ANY($${i}::text[])`);
    params.push(endpointIds);
    i += 1;
  }
  if (environment) {
    parts.push(`${col('environment')} = $${i}`);
    params.push(environment);
    i += 1;
  }
  if (from) {
    parts.push(`${col('bucket_start')} >= $${i}::timestamptz`);
    params.push(from);
    i += 1;
  }
  if (to) {
    parts.push(`${col('bucket_start')} < $${i}::timestamptz`);
    params.push(to);
    i += 1;
  }
  return { text: parts.join(' AND '), params, nextIndex: i };
}

// Everything the console's KPI row needs for one date range, computed in
// Postgres over exact counts rather than in the browser over a sampled buffer.
// Cache wrapper — see server/obsCache.js for why this is a flat short TTL
// rather than the write-invalidated pattern server/cache.js uses for
// workspace reads. endpointIds is an array, so it's joined into the key
// rather than passed as-is (a fresh array reference on every call would
// otherwise never hit the same String(parts) key twice).
async function getSummary(organisation, opts = {}) {
  const { environment, from, to, endpointIds } = opts;
  const key = [organisation, environment, from, to, endpointIds && endpointIds.join(',')];
  const cached = await obsCache.get('summary', key);
  if (cached !== undefined) return cached;
  const result = await getSummaryUncached(organisation, opts);
  await obsCache.set('summary', key, result);
  return result;
}

async function getSummaryUncached(organisation, { environment, from, to, endpointIds } = {}) {
  const w = whereClause(organisation, environment, from, to, '', endpointIds);
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(request_count), 0)::bigint  AS total,
       COALESCE(SUM(status_2xx), 0)::bigint     AS s2,
       COALESCE(SUM(status_3xx), 0)::bigint     AS s3,
       COALESCE(SUM(status_4xx), 0)::bigint     AS s4,
       COALESCE(SUM(status_5xx), 0)::bigint     AS s5,
       COALESCE(SUM(status_unknown), 0)::bigint AS sunknown,
       COALESCE(SUM(latency_sum), 0)::bigint    AS latency_sum,
       COALESCE(SUM(latency_count), 0)::bigint  AS latency_count,
       MIN(latency_min)                          AS latency_min,
       MAX(latency_max)                          AS latency_max,
       COUNT(DISTINCT endpoint_id)::int          AS endpoint_count,
       MAX(bucket_start)                         AS last_seen_at
     FROM ${ROLLUP_SOURCE} rollup WHERE ${w.text}`,
    w.params
  );
  const r = rows[0] || {};

  // The histogram and IP maps are aggregated IN POSTGRES, not by streaming
  // rows back and summing them here. A 30-day range over a hundred endpoints
  // is millions of rollup rows; shipping each one's JSONB to Node to merge it
  // would make the longest ranges - the whole point of keeping a year of
  // rollups - the slowest ones. Expanded with jsonb_each_text and grouped,
  // these return at most 11 and 10 rows respectively however long the range.
  const wr = whereClause(organisation, environment, from, to, 'r', endpointIds);
  const [{ rows: histoRows }, { rows: ipRows }] = await Promise.all([
    pool.query(
      `SELECT kv.key AS k, SUM(kv.value::numeric)::bigint AS v
       FROM ${ROLLUP_SOURCE} r, LATERAL jsonb_each_text(r.latency_buckets) kv
       WHERE ${wr.text}
       GROUP BY kv.key`,
      wr.params
    ),
    pool.query(
      `SELECT kv.key AS ip, SUM(kv.value::numeric)::bigint AS n
       FROM ${ROLLUP_SOURCE} r, LATERAL jsonb_each_text(r.source_ips) kv
       WHERE ${wr.text}
       GROUP BY kv.key ORDER BY 2 DESC LIMIT 10`,
      wr.params
    ),
  ]);
  const latencyBuckets = {};
  for (const row of histoRows) latencyBuckets[row.k] = Number(row.v);
  const topIps = ipRows.map((row) => ({ ip: row.ip, count: Number(row.n) }));

  const total = Number(r.total || 0);
  const errCount = Number(r.s4 || 0) + Number(r.s5 || 0);
  const latencyCount = Number(r.latency_count || 0);

  return {
    total,
    errCount,
    errorRate: total ? errCount / total : 0,
    statusBreakdown: {
      '2xx': Number(r.s2 || 0),
      '3xx': Number(r.s3 || 0),
      '4xx': Number(r.s4 || 0),
      '5xx': Number(r.s5 || 0),
      unknown: Number(r.sunknown || 0),
    },
    topIps,
    endpointCount: Number(r.endpoint_count || 0),
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    latency: latencyCount
      ? {
        count: latencyCount,
        mean: Math.round(Number(r.latency_sum || 0) / latencyCount),
        min: r.latency_min === null ? null : Number(r.latency_min),
        max: r.latency_max === null ? null : Number(r.latency_max),
        p50: percentileFromBuckets(latencyBuckets, 0.5),
        p95: percentileFromBuckets(latencyBuckets, 0.95),
        p99: percentileFromBuckets(latencyBuckets, 0.99),
      }
      : null,
    latencyBuckets,
  };
}

// Time series for the charts, bucketed server-side to whatever resolution the
// range warrants (date_trunc/ floor to `intervalSeconds`) so a 30-day view
// returns a few hundred points instead of 43,200.
async function getSeries(organisation, opts = {}) {
  const { environment, from, to, intervalSeconds = 300, endpointIds } = opts;
  const key = [organisation, environment, from, to, intervalSeconds, endpointIds && endpointIds.join(',')];
  const cached = await obsCache.get('series', key);
  if (cached !== undefined) return cached;
  const result = await getSeriesUncached(organisation, opts);
  await obsCache.set('series', key, result);
  return result;
}

async function getSeriesUncached(organisation, { environment, from, to, intervalSeconds = 300, endpointIds } = {}) {
  const w = whereClause(organisation, environment, from, to, '', endpointIds);
  const seconds = Math.max(60, Math.min(86400, toInt(intervalSeconds, 300)));
  const params = w.params.concat([seconds]);
  const idx = w.nextIndex;

  const { rows } = await pool.query(
    // Explicitly cast the interval parameter: without it Postgres cannot
    // always infer a type for a bare $n used only in arithmetic, and the
    // query fails at runtime with "could not determine data type of parameter".
    `SELECT
       to_timestamp(floor(extract(epoch FROM bucket_start) / $${idx}::numeric) * $${idx}::numeric) AS ts,
       SUM(request_count)::bigint  AS total,
       SUM(status_2xx)::bigint     AS s2,
       SUM(status_3xx)::bigint     AS s3,
       SUM(status_4xx)::bigint     AS s4,
       SUM(status_5xx)::bigint     AS s5,
       SUM(status_unknown)::bigint AS sunknown,
       SUM(latency_sum)::bigint    AS latency_sum,
       SUM(latency_count)::bigint  AS latency_count
     FROM ${ROLLUP_SOURCE} rollup WHERE ${w.text}
     GROUP BY 1 ORDER BY 1 ASC`,
    params
  );

  return rows.map((r) => {
    const latencyCount = Number(r.latency_count || 0);
    return {
      ts: new Date(r.ts).toISOString(),
      total: Number(r.total || 0),
      statusBreakdown: {
        '2xx': Number(r.s2 || 0),
        '3xx': Number(r.s3 || 0),
        '4xx': Number(r.s4 || 0),
        '5xx': Number(r.s5 || 0),
        unknown: Number(r.sunknown || 0),
      },
      meanLatencyMs: latencyCount ? Math.round(Number(r.latency_sum || 0) / latencyCount) : null,
    };
  });
}

// Per-endpoint totals for the range - drives the endpoints table and the
// service-health ranking, sorted and paginated in SQL rather than in the page.
async function getEndpointBreakdown(organisation, { environment, from, to, limit = 500, endpointIds } = {}) {
  const w = whereClause(organisation, environment, from, to, '', endpointIds);
  const params = w.params.concat([Math.max(1, Math.min(2000, toInt(limit, 500)))]);

  // Same reasoning as getSummary: the per-endpoint histogram is summed by
  // Postgres. `jsonb_agg(latency_buckets)` here would build one array per
  // endpoint containing every bucket's JSONB over the whole range and ship
  // all of it to Node - fine over an hour, ruinous over a month.
  const { rows } = await pool.query(
    `WITH totals AS (
       SELECT endpoint_id,
              SUM(request_count)::bigint  AS total,
              SUM(status_2xx)::bigint     AS s2,
              SUM(status_3xx)::bigint     AS s3,
              SUM(status_4xx)::bigint     AS s4,
              SUM(status_5xx)::bigint     AS s5,
              SUM(status_unknown)::bigint AS sunknown,
              SUM(latency_sum)::bigint    AS latency_sum,
              SUM(latency_count)::bigint  AS latency_count,
              MAX(bucket_start)           AS last_seen_at
       FROM ${ROLLUP_SOURCE} rollup WHERE ${w.text}
       GROUP BY endpoint_id
       ORDER BY SUM(request_count) DESC
       LIMIT $${w.nextIndex}
     ),
     histos AS (
       SELECT r.endpoint_id, kv.key AS k, SUM(kv.value::numeric)::bigint AS v
       FROM ${ROLLUP_SOURCE} r
       JOIN totals t ON t.endpoint_id = r.endpoint_id
       CROSS JOIN LATERAL jsonb_each_text(r.latency_buckets) kv
       WHERE ${whereClause(organisation, environment, from, to, 'r', endpointIds).text}
       GROUP BY r.endpoint_id, kv.key
     )
     SELECT totals.*,
            COALESCE(
              (SELECT jsonb_object_agg(h.k, h.v) FROM histos h WHERE h.endpoint_id = totals.endpoint_id),
              '{}'::jsonb
            ) AS histo
     FROM totals
     ORDER BY totals.total DESC`,
    params
  );

  return rows.map((r) => {
    const merged = r.histo || {};
    const total = Number(r.total || 0);
    const errCount = Number(r.s4 || 0) + Number(r.s5 || 0);
    const latencyCount = Number(r.latency_count || 0);
    return {
      endpointId: r.endpoint_id,
      total,
      errCount,
      errorRate: total ? errCount / total : 0,
      statusBreakdown: {
        '2xx': Number(r.s2 || 0),
        '3xx': Number(r.s3 || 0),
        '4xx': Number(r.s4 || 0),
        '5xx': Number(r.s5 || 0),
        unknown: Number(r.sunknown || 0),
      },
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
      latency: latencyCount
        ? {
          count: latencyCount,
          mean: Math.round(Number(r.latency_sum || 0) / latencyCount),
          p50: percentileFromBuckets(merged, 0.5),
          p95: percentileFromBuckets(merged, 0.95),
          p99: percentileFromBuckets(merged, 0.99),
        }
        : null,
    };
  });
}

// Paginated raw records for the Log Explorer. Every filter here is an indexed
// column; the encrypted payload is decrypted only for the page actually being
// returned, never across the whole range.
async function getRecords(organisation, {
  environment, from, to, endpointId, endpointIds, statusFamily, correlationId, clientIp,
  minLatencyMs, limit = 100, offset = 0,
} = {}) {
  const params = [organisation];
  const parts = ['organisation = $1'];
  let i = 2;
  const add = (sql, value) => { parts.push(sql.replace('$?', `$${i}`)); params.push(value); i += 1; };

  if (environment) add('environment = $?', environment);
  if (from) add('ts >= $?::timestamptz', from);
  if (to) add('ts < $?::timestamptz', to);
  if (endpointId) add('endpoint_id = $?', endpointId);
  // The sidebar's API/endpoint scope, which narrows every panel on the page.
  // Independent of `endpointId` above, which is the click-through drill-down -
  // both apply when someone drills into one endpoint inside a scoped API.
  if (Array.isArray(endpointIds) && endpointIds.length) add('endpoint_id = ANY($?::text[])', endpointIds);
  if (correlationId) add('correlation_id = $?', correlationId);
  if (clientIp) add('client_ip = $?', clientIp);
  if (isFiniteNum(Number(minLatencyMs)) && Number(minLatencyMs) > 0) add('latency_ms >= $?', toInt(minLatencyMs));
  if (statusFamily === 'unknown') {
    parts.push('status_code IS NULL');
  } else if (/^[1-5]xx$/.test(statusFamily || '')) {
    const base = Number(statusFamily[0]) * 100;
    add('status_code >= $?', base);
    add('status_code < $?', base + 100);
  }

  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 100)));
  const safeOffset = Math.max(0, toInt(offset, 0));
  const where = parts.join(' AND ');

  // A single real request can produce more than one row here even from one
  // well-behaved agent (see collapse_duplicate_hops() in mule_doc_agent.py),
  // and that agent-side dedup is per-writer state - it cannot see what a
  // SECOND agent (a different Mule node, e.g. a shared/mirrored log path
  // across a cluster) independently pushed for the SAME request. Two writers
  // is the normal case here (see agent health's writerCount), so this can't
  // be treated as a rare edge case. Folding by correlation_id at read time,
  // not at insert time, keeps the insert path a simple append (safe under
  // retry) and lets every drill-down view share one fold instead of each
  // needing its own de-dup pass.
  //
  // Rows with NO correlation id are never folded into each other - Postgres
  // treats every NULL as equal for PARTITION BY, which would otherwise
  // collapse every uncorrelated row in the whole result down to one.
  //
  // Preference mirrors the agent's own _best_hop_record(): the row that
  // actually completed (has a status code) beats one that doesn't, then the
  // one with a latency value, then the most recently written. Path length -
  // the agent's last tiebreaker - isn't available here without decrypting
  // fields_enc for every candidate row just to sort by it, so it's dropped;
  // it only matters when status AND latency already tied, which the id
  // tiebreaker resolves just as well for display purposes.
  const rankedCte = `
    WITH ranked AS (
      SELECT id, ts, endpoint_id, status_code, latency_ms, client_ip,
             correlation_id, flow_name, fields_enc,
             ROW_NUMBER() OVER (
               PARTITION BY correlation_id
               ORDER BY (status_code IS NOT NULL) DESC, (latency_ms IS NOT NULL) DESC, id DESC
             ) AS rn
      FROM endpoint_log_records WHERE ${where}
    )
  `;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `${rankedCte}
       SELECT id, ts, endpoint_id, status_code, latency_ms, client_ip,
              correlation_id, flow_name, fields_enc
       FROM ranked WHERE correlation_id IS NULL OR rn = 1
       ORDER BY ts DESC, id DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params.concat([safeLimit, safeOffset])
    ),
    pool.query(
      `${rankedCte}
       SELECT COUNT(*)::bigint AS n FROM ranked WHERE correlation_id IS NULL OR rn = 1`,
      params
    ),
  ]);

  const records = rows.map((r) => {
    let fields = null;
    if (r.fields_enc) {
      try {
        fields = JSON.parse(dataCrypto.decryptField(r.fields_enc, `obs_record:${organisation}`));
      } catch (err) {
        // A record whose payload cannot be decrypted (key rotated away, row
        // corrupted) still has useful metadata - return it flagged rather
        // than dropping the row and silently shortening the page.
        fields = { _undecryptable: true };
      }
    }
    return {
      id: String(r.id),
      ts: new Date(r.ts).toISOString(),
      endpointId: r.endpoint_id,
      // Null for records written before the name was carried in the payload;
      // the page falls back to resolving the id, then to showing it raw.
      method: fields?.method || null,
      path: fields?.path || null,
      statusCode: r.status_code === null ? null : Number(r.status_code),
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      clientIp: r.client_ip,
      correlationId: r.correlation_id,
      flowName: r.flow_name,
      requestFields: fields?.requestFields || null,
      responseFields: fields?.responseFields || null,
      undecryptable: !!fields?._undecryptable,
    };
  });

  return { records, total: Number(countRows[0]?.n || 0), limit: safeLimit, offset: safeOffset };
}

async function getEnvironments(organisation) {
  const { rows } = await pool.query(
    `SELECT DISTINCT environment FROM ${ROLLUP_SOURCE} rollup WHERE organisation = $1 ORDER BY environment`,
    [organisation]
  );
  return rows.map((r) => r.environment).filter(Boolean);
}

// How far back this org actually has data, so the UI can offer date ranges
// that exist instead of empty ones.
async function getCoverage(organisation, environment) {
  const params = [organisation];
  let text = 'organisation = $1';
  if (environment) { text += ' AND environment = $2'; params.push(environment); }
  const { rows } = await pool.query(
    `SELECT MIN(bucket_start) AS oldest, MAX(bucket_start) AS newest,
            COUNT(*)::bigint AS buckets
     FROM ${ROLLUP_SOURCE} rollup WHERE ${text}`,
    params
  );
  const r = rows[0] || {};
  return {
    oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
    newest: r.newest ? new Date(r.newest).toISOString() : null,
    buckets: Number(r.buckets || 0),
  };
}

// Records "an ingest PUT for this org+environment landed just now" -
// unconditionally, regardless of whether that push carried any rollups or
// records worth writing. This is deliberately a DIFFERENT signal from
// getCoverage() above: coverage answers "when did we last see TRAFFIC",
// which stays frozen through any genuinely quiet spell even with the agent
// perfectly healthy. This answers "when did the agent last push, period",
// which is what "is the collector silent" (server/alertEngine.js's
// agent_silent metric) needs - conflating the two made a quiet-but-alive
// environment indistinguishable from a dead collector.
async function touchHeartbeat(organisation, environment) {
  await pool.query(
    `INSERT INTO agent_heartbeat (organisation, environment, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (organisation, environment) DO UPDATE SET last_seen_at = now()`,
    [organisation, environment]
  );
}

async function getHeartbeat(organisation, environment) {
  const { rows } = await pool.query(
    `SELECT last_seen_at FROM agent_heartbeat WHERE organisation = $1 AND environment = $2`,
    [organisation, environment]
  );
  // No row yet reads as "unknown", not "silent" - see breaches()'s null
  // handling in alertEngine.js, which never treats a missing measurement as
  // a breach. That matters right after this table is first introduced: an
  // environment with a perfectly healthy agent has no heartbeat row until
  // its NEXT push, and must not read as newly-firing in the meantime.
  return { lastSeenAt: rows[0] ? new Date(rows[0].last_seen_at).toISOString() : null };
}

module.exports = {
  LATENCY_BUCKET_BOUNDS,
  LATENCY_BUCKET_KEYS,
  latencyBucketKey,
  percentileFromBuckets,
  ingestRollups,
  ingestRecords,
  getSummary,
  getSeries,
  getEndpointBreakdown,
  getRecords,
  getEnvironments,
  getCoverage,
  touchHeartbeat,
  getHeartbeat,
};
