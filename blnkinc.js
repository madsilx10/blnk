const fs = require('fs');
const readline = require('readline');
const { ethers } = require('ethers');

const DOMAIN = 'blnkinc.xyz';
const URI = 'https://blnkinc.xyz';
const STATEMENT = 'Sign in with Ethereum to BLNK';
const CHAIN_ID = 1;

const PRIVATEKEY_FILE = 'privatekey.txt'; // satu private key per baris
const USN_FILE = 'usn1.txt'; // satu handle X (dgn @ atau tanpa) per baris
const MIN_DELAY = 15000;
const MAX_DELAY = 30000;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
async function cooldown(ms) {
  const totalSec = Math.ceil(ms / 1000);
  for (let s = totalSec; s > 0; s--) {
    process.stdout.write(`\r  cooldown ${s}s...   `);
    await sleep(1000);
  }
  process.stdout.write('\r                      \r');
}
function randomDelay() {
  return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
}

function readLines(path) {
  if (!fs.existsSync(path)) {
    console.error(`File ${path} tidak ditemukan.`);
    process.exit(1);
  }
  return fs.readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
}

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Ch-Ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?1',
  'Sec-Ch-Ua-Platform': '"Android"',
};

async function safeJson(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} - respons bukan JSON (status ${res.status}): ${text.slice(0, 150)}`);
  }
}

function mergeCookies(existing, setCookieArr) {
  const jar = { ...existing };
  for (const c of setCookieArr) {
    const [pair] = c.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return jar;
}

function getSetCookies(res) {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/).filter(Boolean);
}

function cookieHeaderStr(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Load halaman dulu buat dapetin cookie awal (bypass bot-check)
async function initSession() {
  const res = await fetch(`https://${DOMAIN}/dashboard`, {
    headers: { ...COMMON_HEADERS, 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
  });
  await res.text();
  return mergeCookies({}, getSetCookies(res));
}

async function getNonce(cookieJar) {
  const res = await fetch(`https://${DOMAIN}/api/auth/nonce`, {
    headers: {
      ...COMMON_HEADERS,
      Referer: `https://${DOMAIN}/dashboard`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: cookieHeaderStr(cookieJar),
    },
  });
  const text = await res.text();
  if (!text || text.trim().startsWith('<')) {
    throw new Error(`getNonce - respons bukan nonce (status ${res.status}): ${text.slice(0, 150)}`);
  }
  Object.assign(cookieJar, mergeCookies({}, getSetCookies(res)));
  return text.trim();
}

function buildSiweMessage({ address, nonce, issuedAt }) {
  return `${DOMAIN} wants you to sign in with your Ethereum account:
${address}

${STATEMENT}

URI: ${URI}
Version: 1
Chain ID: ${CHAIN_ID}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}

async function submitTwitterHandle(handle, cookieJar) {
  const res = await fetch(`https://${DOMAIN}/api/tasks/twitter`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/json',
      Origin: `https://${DOMAIN}`,
      Referer: `https://${DOMAIN}/dashboard`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: cookieHeaderStr(cookieJar),
    },
    body: JSON.stringify({ handle }),
  });

  const data = await safeJson(res, 'submitTwitterHandle');
  if (!data.ok) throw new Error(`gagal submit twitter: ${JSON.stringify(data)}`);
  return data;
}

async function connectWallet(privateKey, handle) {
  const wallet = new ethers.Wallet(privateKey);
  const cookieJar = await initSession();
  const nonce = await getNonce(cookieJar);
  const issuedAt = new Date().toISOString();

  const messageToSign = buildSiweMessage({ address: wallet.address, nonce, issuedAt });
  const signature = await wallet.signMessage(messageToSign);

  const res = await fetch(`https://${DOMAIN}/api/auth/verify`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/json',
      Origin: `https://${DOMAIN}`,
      Referer: `https://${DOMAIN}/dashboard`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Cookie: cookieHeaderStr(cookieJar),
    },
    body: JSON.stringify({
      message: {
        domain: DOMAIN,
        address: wallet.address,
        statement: STATEMENT,
        uri: URI,
        version: '1',
        chainId: CHAIN_ID,
        nonce,
        issuedAt,
      },
      signature,
    }),
  });

  const data = await safeJson(res, 'connectWallet');
  if (!data.ok) throw new Error(`gagal verify: ${JSON.stringify(data)}`);

  Object.assign(cookieJar, mergeCookies({}, getSetCookies(res)));

  const taskResult = await submitTwitterHandle(handle, cookieJar);

  return { address: wallet.address, coins: taskResult.coins };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

async function selectAccounts(total) {
  console.log('\n1. 1 akun\n2. Semua akun\n3. From x to end\n');
  const mode = await ask('Pilihan (1/2/3): ');

  if (mode === '1') {
    const num = await ask(`Nomor akun (1-${total}): `);
    const idx = parseInt(num, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= total) { console.error('Nomor tidak valid.'); process.exit(1); }
    return [idx];
  }
  if (mode === '2') return Array.from({ length: total }, (_, i) => i);
  if (mode === '3') {
    const from = await ask(`Mulai dari nomor (1-${total}): `);
    const start = parseInt(from, 10) - 1;
    if (Number.isNaN(start) || start < 0 || start >= total) { console.error('Nomor tidak valid.'); process.exit(1); }
    return Array.from({ length: total - start }, (_, i) => start + i);
  }
  console.error('Pilihan tidak valid.');
  process.exit(1);
}

async function main() {
  const privateKeys = readLines(PRIVATEKEY_FILE);
  const handles = readLines(USN_FILE);

  if (privateKeys.length === 0) { console.error('Tidak ada private key.'); return; }
  if (privateKeys.length !== handles.length) {
    console.error(`Jumlah baris ${PRIVATEKEY_FILE} (${privateKeys.length}) dan ${USN_FILE} (${handles.length}) tidak sama.`);
    return;
  }

  const indices = await selectAccounts(privateKeys.length);
  const selected = indices.map((idx) => ({ privateKey: privateKeys[idx], handle: handles[idx], originalNum: idx + 1 }));

  for (let i = 0; i < selected.length; i++) {
    const { privateKey, handle, originalNum } = selected[i];

    process.stdout.write(`[PROSES] akun ${originalNum} - connect wallet + submit ${handle} ... `);

    try {
      const { address, coins } = await connectWallet(privateKey, handle);
      console.log(`OK (${address}, +${coins} coins)`);
    } catch (err) {
      console.log(`ERROR - ${err.message}`);
    }

    if (i !== selected.length - 1) await cooldown(randomDelay());
  }

  console.log('\nSelesai.');
}

main();
