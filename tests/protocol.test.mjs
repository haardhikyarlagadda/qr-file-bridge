// Protocol round-trip tests. Run with:  node tests/protocol.test.mjs
// Covers: Base45, frame codec + CRC, manifest, ACK ranges, full
// compress→encrypt→chunk→decode→reassemble→decrypt→verify pipeline,
// wrong-passphrase rejection, and corruption handling.
import { b45encode, b45decode } from '../js/base45.js';
import { compress, decompress, encrypt, decrypt, sha256hex } from '../js/crypto.js';
import { encodeFrame, decodeFrame, encodeManifest, decodeManifest,
         encodeAck, decodeAck, MAGIC_DATA } from '../js/frame.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.error("FAIL:", name)); };

for (const len of [0,1,2,3,255,256,801]) {
  const data = new Uint8Array(len).map((_,i)=> (i*37+len)%256);
  const rt = b45decode(b45encode(data));
  ok(`base45 len ${len}`, rt.length===data.length && rt.every((b,i)=>b===data[i]));
}
const big = new Uint8Array(2000).map((_,i)=>i%256);
ok("base45 charset is QR-alphanumeric", /^[0-9A-Z $%*+\-./:]*$/.test(b45encode(big)));

const file = crypto.getRandomValues(new Uint8Array(50_000));
const digest = await sha256hex(file);
const { data: comp, algo } = await compress(file);
const { ciphertext, nonce, salt } = await encrypt(comp, "hunter2");
const chunkSize = 400;
const total = Math.ceil(ciphertext.length / chunkSize);
ok("multiple frames produced", total > 100);
const sessionId = 0xDEADBEEF;

const manifest = encodeManifest({ name:"test.bin", origSize:file.length,
  compSize:comp.length, totalFrames:total, chunkSize, compAlgo:algo,
  salt, nonce, sha256:digest });

const frames = [ encodeFrame(MAGIC_DATA, sessionId, 0, total, manifest) ];
for (let i=0;i<total;i++)
  frames.push(encodeFrame(MAGIC_DATA, sessionId, i+1, total,
    ciphertext.slice(i*chunkSize,(i+1)*chunkSize)));
ok("all frames QR-alphanumeric", frames.every(f=>/^[0-9A-Z $%*+\-./:]*$/.test(f)));

const order = [...frames.keys()].sort(()=>Math.random()-0.5);
order.push(1, 1, 0);
const chunks = new Map(); let mf=null; let decodeFailures=0;
for (const i of order) {
  const fr = decodeFrame(frames[i]);
  if (!fr || fr.sessionId!==sessionId) { decodeFailures++; continue; }
  if (fr.frameIndex===0) { if(!mf) mf = decodeManifest(fr.payload); }
  else if (!chunks.has(fr.frameIndex)) chunks.set(fr.frameIndex, fr.payload);
}
ok("zero decode failures", decodeFailures===0);
ok("all chunks received out-of-order", chunks.size === total);
ok("manifest intact", mf && mf.name==="test.bin" && mf.totalFrames===total);

const ct2 = new Uint8Array(ciphertext.length); let off=0;
for (let i=1;i<=total;i++){ const c=chunks.get(i); ct2.set(c,off); off+=c.length; }
const plain = await decompress(await decrypt(ct2, "hunter2", mf.salt, mf.nonce), mf.compAlgo);
ok("plaintext identical", plain.length===file.length && plain.every((b,i)=>b===file[i]));
ok("sha256 verifies", await sha256hex(plain) === mf.sha256);

let threw=false;
try { await decrypt(ct2, "wrong", mf.salt, mf.nonce); } catch { threw=true; }
ok("wrong passphrase rejected by GCM tag", threw);

ok("corrupt frame -> null (CRC)", decodeFrame(frames[5].slice(0,-4)+"AAAA") === null);
ok("garbage -> null", decodeFrame("HELLO WORLD 123") === null);

const ack = decodeAck(decodeFrame(encodeAck(sessionId, 0x01, [5,6,7,12,40,41])).payload);
ok("ack ranges round-trip", JSON.stringify(ack.missing)===JSON.stringify([5,6,7,12,40,41]) && ack.status===1);

const tiny = new Uint8Array([42]);
const tc = await compress(tiny);
const te2 = await encrypt(tc.data, "p");
const tp = await decompress(await decrypt(te2.ciphertext, "p", te2.salt, te2.nonce), tc.algo);
ok("1-byte file survives", tp.length===1 && tp[0]===42);

const m2 = decodeManifest(encodeManifest({ name:"résumé 简历.pdf", origSize:1, compSize:1,
  totalFrames:1, chunkSize:400, compAlgo:"none", salt:new Uint8Array(16), nonce:new Uint8Array(12), sha256:"ab" }));
ok("unicode filename", m2.name==="résumé 简历.pdf");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
