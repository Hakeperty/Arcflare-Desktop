// A macOS app opened from Finder or the Dock starts with launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), not the one your terminal has. So Homebrew's
// python3.12, git and llama-server are invisible to it, and every setup or
// download the app runs fails with an exit code that the same command in
// Terminal doesn't. This asks your login shell for its PATH once at startup and
// adds the usual Homebrew folders, so the app sees what Terminal sees.

const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MARK = "__ARCFLARE_PATH__";

function loginShellPath() {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // -i -l: the files people put PATH in (.zprofile, .zshrc, .bash_profile).
    const r = spawnSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" },
    });
    const m = new RegExp(`${MARK}(.*?)${MARK}`).exec(r.stdout || "");
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

module.exports = function fixPath() {
  if (process.platform !== "darwin") return;
  const parts = [
    ...loginShellPath().split(":"),
    ...(process.env.PATH || "").split(":"),
    "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
  ].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(":");
};
