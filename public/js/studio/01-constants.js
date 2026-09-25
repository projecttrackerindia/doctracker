/* ==================== SECTION:CONSTANTS ==================== */
const NEW_KEY = 'apiStudio_workspace_v1';
const OLD_KEY = 'apiDocsTool_projects_v1';
const THEME_KEY = 'apiStudio_theme';
const ENV_KEY = 'apiStudio_env';
const AUTHOR_KEY = 'apiStudio_authorName';
const ROLE_KEY = 'apiStudio_authorRole';
const PROFILE_COLOR_KEY = 'apiStudio_profileColor';
const SIDEBAR_KEY = 'apiStudio_sidebarCollapsed';
const AUTO_SECTION_KEY = 'apiStudio_autoSectionOpen';
const DISCOVERY_NEW_ONLY_KEY = 'apiStudio_discoveryNewOnly'; // hide auto-discovered endpoints that are already documented — see reconcileDiscovery() in 05-util.js
const AUDIT_KEY = 'apiStudio_auditLog';
const AUDIT_LOG_CAP = 1000; // server also caps this, kept here for the in-memory array
const MIGRATED_FLAG_KEY = 'apiStudio_migratedToServer_v1'; // set once this browser's old localStorage data has been moved to Postgres
