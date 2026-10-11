// electron-builder's afterSign hook: give the macOS app an ad-hoc signature
// when there is no certificate to sign it with.
//
// With no signing identity electron-builder leaves the app unsigned, and an
// unsigned app on Apple silicon is the one macOS calls "damaged and can't be
// opened", with no way past it in the UI. An ad-hoc signature (`codesign -s -`)
// costs nothing and turns that into the ordinary "unidentified developer"
// prompt, which Privacy & Security → Open Anyway can answer. (The curl
// installer, install-desktop.sh, skips the prompt altogether.)
//
// When CSC_LINK / CSC_NAME is set, electron-builder has already signed with a
// real identity, and this does nothing. It never fails the build: an app that
// ships without the ad-hoc signature is no worse than before.

const path = require("path");
const { execFileSync } = require("child_process");

function adhocSign(app, run = execFileSync, log = console) {
  try {
    run("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
    log.log(`  • ad-hoc signed ${path.basename(app)} (no certificate configured)`);
    return true;
  } catch (e) {
    log.warn(`  • could not ad-hoc sign ${path.basename(app)}: ${e.message}`);
    return false;
  }
}

module.exports = async function afterSign(context, run, log) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  adhocSign(app, run, log);
};
module.exports.adhocSign = adhocSign;
