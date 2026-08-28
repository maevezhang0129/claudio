/**
 * 给本机签一张局域网可用的 TLS 证书。
 *
 * 为什么必须有这一步：http://<局域网IP> 不是安全上下文，
 * 于是 Service Worker、「添加到主屏幕」、以及阶段②整曲播放所依赖的
 * 播放 SDK 全部不可用 —— 它们都硬性要求 https。自签名证书浏览器不认，
 * 所以用 mkcert：它往系统信任库里装一个本地 CA，由这个 CA 签出来的
 * 证书对本机浏览器就是「绿锁」。
 *
 * 证书绑定 IP，而局域网 IP 会变（换 WiFi、DHCP 续租）。
 * 换了网络就重跑一次，不用改任何代码。
 *
 * 跑法：npm run certs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CERT_DIR = path.join(ROOT, "certs");

export const CERT_FILE = path.join(CERT_DIR, "local-cert.pem");
export const KEY_FILE = path.join(CERT_DIR, "local-key.pem");

/** 本机所有对外的 IPv4 —— 有线和无线可能同时在，全都签进去 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function mkcert(args) {
  // brew 装在 /opt/homebrew（Apple Silicon）或 /usr/local（Intel），
  // 而 npm scripts 继承的 PATH 未必包含它们
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
  return execFileSync("mkcert", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function main() {
  try {
    mkcert(["-CAROOT"]);
  } catch {
    console.error(`
  没找到 mkcert。先装它：

      brew install mkcert
      mkcert -install       # 往系统信任库装本地 CA，会要一次密码

  然后重跑 npm run certs
`);
    process.exit(1);
  }

  const names = ["localhost", "127.0.0.1", "::1", ...lanAddresses()];
  mkdirSync(CERT_DIR, { recursive: true });
  mkcert(["-cert-file", CERT_FILE, "-key-file", KEY_FILE, ...names]);

  const caRoot = mkcert(["-CAROOT"]).trim();
  console.log(`
  证书已签发，覆盖：${names.join("  ")}

  证书   certs/local-cert.pem
  私钥   certs/local-key.pem（已 gitignore）

  手机要认这张证书，得单独装一次本地 CA：
    1. 把 ${path.join(caRoot, "rootCA.pem")} 传到手机（AirDrop 最快）
    2. iOS：设置 → 已下载描述文件 → 安装
    3. iOS：设置 → 通用 → 关于本机 → 证书信任设置 → 打开 mkcert 那一项

  换了 WiFi、IP 变了就重跑 npm run certs。
`);
}

main();
