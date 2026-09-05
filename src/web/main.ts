/**
 * Frontend entry point placeholder. Phase 0 only wires up tooling; the
 * reactive core, app shell and pages arrive in later phases.
 */
import { APP_VERSION } from '../shared/version.js';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
    app.textContent = `area-overview v${APP_VERSION}`;
}
