'use strict';
// Reaching the board from another computer of yours, through Tailscale.
//
// The board is a page that can do anything on this computer as you (start Claude conversations, run "!" commands,
// read your mail), so it is never put on an ordinary network. When this is switched on (the setting remoteTailscale),
// it listens on ONE more address: this computer's Tailscale address (100.x). Nothing on the office or home network
// reaches that address; only devices in your Tailscale network do, and Tailscale encrypts the connection end to end.
//
// On top of that every request that comes in that way is checked against who sent it: Tailscale is asked which device
// the address belongs to (`tailscale status --json`), and only devices signed in to the SAME account as this computer
// are let through. That is the device check asked for - by the device's key, which cannot be copied the way a network
// card's MAC address can (a MAC is sent in the clear to everyone on the network, and is gone after the first router).
// The board's key is still needed as well.
const { execFile } = require('child_process');
const fs = require('fs');

const EXE_CANDIDATES = ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
function exe() { for (const p of EXE_CANDIDATES) { try { if (fs.statSync(p).isFile()) return p; } catch (e) {} } return 'tailscale'; }

function statusJson(run) {
  return new Promise((resolve) => {
    (run || execFile)(exe(), ['status', '--json'], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout || ''))); } catch (e) { resolve(null); }
    });
  });
}

// -> {ok, ip, name, user, devices: [{name, ip, online, mine}]} or {ok: false, why}
async function info(run) {
  const j = await statusJson(run);
  if (!j || !j.Self) return { ok: false, why: '這台電腦找不到 Tailscale，或它沒有在執行' };
  if (j.BackendState && j.BackendState !== 'Running') return { ok: false, why: j.BackendState === 'NeedsLogin' ? 'Tailscale 還沒登入' : 'Tailscale 的狀態是 ' + j.BackendState };
  const v4 = (ips) => (ips || []).find((x) => /^100\./.test(x)) || '';
  const me = j.Self.UserID;
  const login = (id) => { const u = j.User && (j.User[id] || j.User[String(id)]); return u ? u.LoginName : ''; };
  return {
    ok: true, ip: v4(j.Self.TailscaleIPs), name: String(j.Self.DNSName || j.Self.HostName || '').replace(/\.$/, ''), user: login(me),
    devices: Object.values(j.Peer || {}).map((p) => ({ name: p.HostName, ip: v4(p.TailscaleIPs), online: !!p.Online, mine: p.UserID === me, os: p.OS || '' })),
  };
}

// Is a request from this address let in? Loopback always (this computer). Anything else: only an address Tailscale
// says belongs to a device of the same account. Asked of Tailscale at most every 20 seconds.
class Gate {
  constructor(o = {}) { this.run = o.run; this.at = 0; this.ok = new Set(); this.busy = null; }
  async refresh() {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const i = await info(this.run);
      const ok = new Set();
      if (i.ok) { if (i.ip) ok.add(i.ip); for (const d of i.devices) if (d.mine && d.ip) ok.add(d.ip); }
      this.ok = ok; this.at = Date.now(); this.info = i; this.busy = null;
    })();
    return this.busy;
  }
  async allows(addr) {
    const a = String(addr || '').replace(/^::ffff:/, '');
    if (a === '127.0.0.1' || a === '::1') return true;
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(a)) return false;   // not a Tailscale address (100.64.0.0/10)
    if (Date.now() - this.at > 20000 || (!this.ok.has(a) && Date.now() - this.at > 3000)) await this.refresh();
    return this.ok.has(a);
  }
}

module.exports = { info, Gate, exe };
