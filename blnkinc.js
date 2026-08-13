const fs = require('fs');
const readline = require('readline');
const { ethers } = require('ethers');
const { SiweMessage } = require('siwe');

const DOMAIN = 'blnkinc.xyz';
const URI = 'https://blnkinc.xyz';
const STATEMENT = 'Sign in with Ethereum to BLNK';
const CHAIN_ID = 1;

const PRIVATEKEY_FILE = 'privatekey.txt'; // satu private key per baris
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

function extractCookieValue(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function getNonce() {
  const res = await fetch(`https://${DOMAIN}/api/auth/nonce`);
  const nonce = (await res.text()).trim();
  if (!nonce) throw new Error('gagal ambil nonce');
  return nonce;
}

async function connectWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey);
  const nonce = await getNonce();

  const siweMessage = new SiweMessage({
    domain: DOMAIN,
    address: wallet.address,
    statement: STATEMENT,
    uri: URI,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
  });

  const messageToSign = siweMessage.prepareMessage();
  const signature = await wallet.signMessage(messageToSign);

  const res = await fetch(`https://${DOMAIN}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        domain: siweMessage.domain,
        address: siweMessage.address,
        statement: siweMessage.statement,
        uri: siweMessage.uri,
        version: siweMessage.version,
        chainId: siweMessage.chainId,
        nonce: siweMessage.nonce,
        issuedAt: siweMessage.issuedAt,
      },
      signature,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`gagal verify: ${JSON.stringify(data)}`);

  const setCookie = res.headers.get('set-cookie') || '';
  const sessionCookie = extractCookieValue(setCookie, 'blnk_siwe');

  return { address: wallet.address, sessionCookie };
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
  if (privateKeys.length === 0) { console.error('Tidak ada private key.'); return; }

  const indices = await selectAccounts(privateKeys.length);
  const selected = indices.map((idx) => ({ privateKey: privateKeys[idx], originalNum: idx + 1 }));

  for (let i = 0; i < selected.length; i++) {
    const { privateKey, originalNum } = selected[i];

    process.stdout.write(`[PROSES] akun ${originalNum} - connect wallet ... `);

    try {
      const { address } = await connectWallet(privateKey);
      console.log(`OK (${address})`);
    } catch (err) {
      console.log(`ERROR - ${err.message}`);
    }

    if (i !== selected.length - 1) await cooldown(randomDelay());
  }

  console.log('\nSelesai.');
}

main();
