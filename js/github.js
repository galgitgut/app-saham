/*
 * github.js — baca/tulis file di repo privat `data-saham` lewat GitHub API.
 *
 * - Baca file: diunduh sekali, lalu disimpan di cache browser berdasarkan "sha" (sidik jari file).
 *   Kalau file di GitHub tidak berubah, app memakai salinan di HP/laptop → hemat kuota & cepat.
 * - Tulis file: SEMUA perubahan dikumpulkan jadi SATU commit (bukan satu commit per file),
 *   supaya jumlah push tetap sedikit.
 */
(function (global) {
  'use strict';

  const API = 'https://api.github.com';
  const CACHE_NAME = 'data-saham-v1';

  class GitHub {
    constructor({ owner, repo, token, branch = 'main' }) {
      this.owner = owner;
      this.repo = repo;
      this.token = token;
      this.branch = branch;
    }

    async _req(method, url, body, accept = 'application/vnd.github+json') {
      const res = await fetch(url.startsWith('http') ? url : `${API}/repos/${this.owner}/${this.repo}${url}`, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).message || msg; } catch (_) { /* biarkan */ }
        throw new Error(`GitHub ${res.status}: ${msg}`);
      }
      return res;
    }

    /** Cek token & akses repo. */
    async check() {
      const res = await this._req('GET', '');
      if (!res) throw new Error(`Repo ${this.owner}/${this.repo} tidak ditemukan atau token tidak punya akses.`);
      const info = await res.json();
      if (!info.private) throw new Error('PERINGATAN: repo data ini PUBLIK. Ubah jadi Private di GitHub.');
      return info;
    }

    /** Daftar isi folder → [{name, path, sha, size}] ([] kalau folder belum ada). */
    async list(dir) {
      const res = await this._req('GET', `/contents/${dir}?ref=${this.branch}`);
      if (!res) return [];
      const items = await res.json();
      return Array.isArray(items) ? items.filter((x) => x.type === 'file') : [];
    }

    /**
     * Unduh isi file (Uint8Array). Pakai cache kalau sha sama.
     * @param {string} path
     * @param {string} [sha] sha dari list(); kalau ada, cache dipakai
     */
    async getBytes(path, sha) {
      const key = `https://cache.local/${path}@${sha}`;
      const cache = sha && typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null;
      if (cache) {
        const hit = await cache.match(key);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
      }
      const res = await this._req('GET', `/contents/${path}?ref=${this.branch}`, null, 'application/vnd.github.raw');
      if (!res) return null;
      const buf = await res.arrayBuffer();
      if (cache) await cache.put(key, new Response(buf));
      return new Uint8Array(buf);
    }

    /** Apakah file (dengan sha ini) sudah tersimpan di perangkat? */
    async isCached(path, sha) {
      if (typeof caches === 'undefined') return false;
      const cache = await caches.open(CACHE_NAME);
      return !!(await cache.match(`https://cache.local/${path}@${sha}`));
    }

    /** Hapus salinan file tertentu dari perangkat. */
    async uncache(items) {
      if (typeof caches === 'undefined') return;
      const cache = await caches.open(CACHE_NAME);
      for (const x of items) await cache.delete(`https://cache.local/${x.path}@${x.sha}`);
    }

    async getText(path) {
      const b = await this.getBytes(path);
      return b ? new TextDecoder().decode(b) : null;
    }

    /** Hapus cache lama (file yang sha-nya sudah tidak dipakai). */
    async pruneCache(keepPaths) {
      if (typeof caches === 'undefined') return;
      const cache = await caches.open(CACHE_NAME);
      const keep = new Set(keepPaths.map((x) => `https://cache.local/${x.path}@${x.sha}`));
      for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    }

    /**
     * Tulis beberapa file sekaligus dalam SATU commit.
     * @param {Array<{path:string, bytes?:Uint8Array, text?:string, delete?:boolean}>} files
     * @param {string} message pesan commit
     * @param {(msg:string)=>void} [progress]
     */
    async commit(files, message, progress = () => {}) {
      const ref = await this._req('GET', `/git/ref/heads/${this.branch}`);
      if (!ref) throw new Error('Branch main belum ada. Pastikan repo dibuat dengan centang "Add a README file".');
      const headSha = (await ref.json()).object.sha;
      const head = await (await this._req('GET', `/git/commits/${headSha}`)).json();

      const tree = [];
      let k = 0;
      for (const f of files) {
        k++;
        if (f.delete) {
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        progress(`Mengunggah ${k}/${files.length}: ${f.path}`);
        const bytes = f.bytes || new TextEncoder().encode(f.text);
        const blob = await (await this._req('POST', '/git/blobs', { content: toBase64(bytes), encoding: 'base64' })).json();
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      progress('Membuat commit…');
      const newTree = await (await this._req('POST', '/git/trees', { base_tree: head.tree.sha, tree })).json();
      const newCommit = await (await this._req('POST', '/git/commits', {
        message, tree: newTree.sha, parents: [headSha],
      })).json();
      await this._req('PATCH', `/git/refs/heads/${this.branch}`, { sha: newCommit.sha });
      progress('Tersimpan di GitHub.');
      return newCommit.sha;
    }
  }

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }

  global.GitHub = GitHub;
  if (typeof module !== 'undefined' && module.exports) module.exports = GitHub;
})(typeof window !== 'undefined' ? window : globalThis);
