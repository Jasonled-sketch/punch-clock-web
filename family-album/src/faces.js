// 人臉偵測 + 128 維特徵向量。全部在自己的伺服器上算（不送任何雲端），
// 「這是誰」是靠家人自己在認人頁標過的臉來比對 —— 不是靠 AI 認臉。
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';

const require = createRequire(import.meta.url);
let ready = null;
let faceapi, tf;

async function init() {
  tf = require('@tensorflow/tfjs');
  const wasm = require('@tensorflow/tfjs-backend-wasm');
  faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  const wasmDir = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')) + '/dist/';
  wasm.setWasmPaths(wasmDir); // 不用 platform fetch → 走 Node 檔案系統讀 .wasm
  await tf.setBackend('wasm');
  await tf.ready();
  const modelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
}

export function facesReady() {
  if (!ready) ready = init();
  return ready;
}

let queue = Promise.resolve(); // wasm 後端一次跑一張，排隊避免記憶體爆掉

/**
 * @param {Buffer} jpeg 已轉正（EXIF 方向已套用）的 JPEG
 * @returns {Promise<Array<{box:{x,y,w,h}, score:number, descriptor:Float32Array}>>} box 為 0~1 相對座標
 */
export function detectFaces(jpeg) {
  const run = async () => {
    await facesReady();
    const { data, info } = await sharp(jpeg)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    try {
      const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: config.faces.minConfidence, maxResults: 20 });
      const results = await faceapi.detectAllFaces(tensor, opts).withFaceLandmarks().withFaceDescriptors();
      return results
        .filter(r => Math.min(r.detection.box.width, r.detection.box.height) >= config.faces.minSize * (info.width / 1024 < 1 ? info.width / 1024 : 1))
        .map(r => {
          const b = r.detection.box;
          return {
            box: {
              x: Math.max(0, b.x / info.width), y: Math.max(0, b.y / info.height),
              w: Math.min(1, b.width / info.width), h: Math.min(1, b.height / info.height)
            },
            score: r.detection.score,
            descriptor: new Float32Array(r.descriptor)
          };
        });
    } finally {
      tf.dispose(tensor);
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export const toBlob = d => Buffer.from(d.buffer, d.byteOffset, d.byteLength);
export const fromBlob = b => new Float32Array(new Uint8Array(b).buffer);
