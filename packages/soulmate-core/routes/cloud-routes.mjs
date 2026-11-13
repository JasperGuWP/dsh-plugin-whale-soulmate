// AIGC cloud routes: consent, device auth, key management, sync, wipe.
// Zero network traffic until consentGiven is true (enforced inside the gateway).

import { maskKey, saveConfigAuto, saveCredentials } from '../state.mjs';
import { appendPrivacyAudit, readPrivacyAudit } from '../privacy-firewall.mjs';
import { jsonOut } from '../http-plumbing.mjs';

export function cloudRoutes({ home, gateway, service, memory, getSummary, pushEvent }) {
  const { syncCloud, mountCapabilities } = service;
  // clearCapabilities / the live capability list live on the memory runtime.
  const { clearCapabilities } = memory;

  async function cloudAction(body) {
    const action = body.action ?? 'sync';
    switch (action) {
      case 'status': {
        const summary = await getSummary();
        return { ok: true, cloud: summary.config.cloud, audit: await readPrivacyAudit(home, 20), capabilities: memory.capabilities };
      }
      case 'consent': {
        const consent = body.consent === true;
        const patch = { cloud: { consentGiven: consent, enabled: consent } };
        if (consent) patch.cloud.consentAt = new Date().toISOString();
        if (typeof body.serverUrl === 'string') patch.cloud.serverUrl = body.serverUrl.trim();
        if (typeof body.e2ee === 'boolean') patch.cloud.e2ee = body.e2ee;
        await saveConfigAuto(home, patch);
        if (typeof body.e2eePassphrase === 'string' && body.e2eePassphrase) await saveCredentials(home, { e2eePassphrase: body.e2eePassphrase });
        await appendPrivacyAudit(home, { action: consent ? 'cloud_consent_given' : 'cloud_consent_withdrawn' });
        return { ok: true, ...(await getSummary()) };
      }
      case 'set_key': {
        if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) return { ok: false, error: 'apiKey is required' };
        if (typeof body.serverUrl === 'string' && body.serverUrl.trim()) await saveConfigAuto(home, { cloud: { serverUrl: body.serverUrl.trim() } });
        await saveCredentials(home, { apiKey: body.apiKey.trim() });
        return { ok: true, apiKeyMasked: maskKey(body.apiKey.trim()) };
      }
      case 'device_code':
        return gateway.startDeviceAuth();
      case 'device_token':
        return gateway.pollDeviceToken(String(body.deviceCode ?? ''));
      case 'verify':
        return gateway.verifyConnection();
      case 'mount':
        return mountCapabilities();
      case 'wipe': {
        if (body.confirm !== true) return { ok: false, error: 'wipe requires confirm:true' };
        const res = await gateway.wipeRemoteData();
        if (res.ok) {
          clearCapabilities();
          pushEvent('wipe', {});
        }
        return res;
      }
      case 'sync':
        return syncCloud();
      default:
        return { ok: false, error: `unknown sync action "${action}"` };
    }
  }

  return [
    {
      method: 'POST',
      paths: ['/dsh-soulmate/api/sync'],
      handler: async ({ body }) => {
        const res = await cloudAction(body);
        return jsonOut(200, res);
      },
    },
  ];
}
