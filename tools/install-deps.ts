import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root });
const primary = common.success ? dirname(common.stdout.toString().trim()) : root;
const framework = resolve(root, process.env.EXACT || process.env.EXACT2 || resolve(primary, "../../expo-exact"));
if (!existsSync(join(framework, "packages/barcode-detection/package.json"))) throw new Error("Set EXACT to the Expo Exact checkout.");
const link = join(root, ".exact", "framework");
mkdirSync(dirname(link), { recursive: true });
if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(framework, link, "dir");
else if (!existsSync(link) || realpathSync(link) !== realpathSync(framework)) throw new Error("The .exact/framework link points at a different checkout. Review it before reinstalling.");
process.exitCode = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: root, stdout: "inherit", stderr: "inherit" }).exitCode;
