#!/usr/bin/env python3
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile


def run(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise ValueError(f"{args[0]} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def require(condition, message):
    if not condition:
        raise ValueError(message)


def signing_certificate(app, prefix):
    run("codesign", "-d", "--extract-certificates", str(prefix), str(app))
    certificate = Path(str(prefix) + "0").read_bytes()
    return hashlib.sha1(certificate).hexdigest().upper()


def prepare(ipa, identity, manifest):
    identity = identity.upper()
    require(re.fullmatch(r"[0-9A-F]{40}", identity), "Use a SHA-1 identity from security find-identity.")
    require(ipa.is_file(), "IPA does not exist.")
    privacy = plistlib.loads(manifest.read_bytes())
    require(isinstance(privacy, dict), "Privacy manifest must be a property-list dictionary.")
    reasons = privacy.get("NSPrivacyAccessedAPITypes")
    require(isinstance(reasons, list) and reasons, "Privacy manifest has no required-reason declarations.")
    for entry in reasons:
        require(isinstance(entry, dict) and isinstance(entry.get("NSPrivacyAccessedAPIType"), str)
                and isinstance(entry.get("NSPrivacyAccessedAPITypeReasons"), list)
                and entry["NSPrivacyAccessedAPITypeReasons"]
                and all(isinstance(reason, str) and reason for reason in entry["NSPrivacyAccessedAPITypeReasons"]),
                "Invalid required-reason declaration.")

    with tempfile.TemporaryDirectory(prefix=".testflight-", dir=ipa.parent) as directory:
        root = Path(directory)
        unpacked = root / "unpacked"
        run("ditto", "-x", "-k", str(ipa), str(unpacked))
        apps = list((unpacked / "Payload").glob("*.app"))
        require(len(apps) == 1, "Expected exactly one app in Payload.")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        bundle = info.get("CFBundleIdentifier")
        version = info.get("CFBundleShortVersionString")
        build = info.get("CFBundleVersion")
        require(bundle == "com.exact.t3code.ios", "Unexpected bundle identifier.")
        require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "Archive is not an iPhoneOS build.")
        require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version), "Unresolved marketing version.")
        require(isinstance(build, str) and re.fullmatch(r"[1-9]\d*(?:\.\d+){0,2}", build), "Unresolved build number.")
        run("codesign", "--verify", "--deep", "--strict", str(app))
        require(signing_certificate(app, root / "original-cert") == identity,
                "Supplied identity differs from the archive signer.")

        profile = plistlib.loads(run("security", "cms", "-D", "-i", str(app / "embedded.mobileprovision")))
        allowed = profile.get("Entitlements", {})
        signed = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(app)))
        team = signed.get("com.apple.developer.team-identifier")
        require(isinstance(team, str) and team in profile.get("TeamIdentifier", []), "Signing team differs from profile.")
        require(allowed.get("application-identifier") == f"{team}.{bundle}"
                and signed.get("application-identifier") == allowed["application-identifier"],
                "Provisioning profile does not match this app.")
        expiry = profile.get("ExpirationDate")
        require(isinstance(expiry, datetime.datetime)
                and expiry.replace(tzinfo=datetime.timezone.utc) > datetime.datetime.now(datetime.timezone.utc),
                "Provisioning profile is missing an expiry or has expired.")
        require("iOS" in profile.get("Platform", []) and "ProvisionedDevices" not in profile
                and not profile.get("ProvisionsAllDevices") and allowed.get("get-task-allow") is False
                and signed.get("get-task-allow", False) is False and allowed.get("beta-reports-active") is True,
                "Archive requires an App Store distribution profile.")
        require(identity in {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])},
                "Signing certificate is not allowed by the provisioning profile.")

        destination = app / "PrivacyInfo.xcprivacy"
        require(not destination.exists() or plistlib.loads(destination.read_bytes()) == privacy,
                "An existing privacy manifest differs; merge it before packaging.")
        shutil.copyfile(manifest, destination)
        entitlements = root / "entitlements.plist"
        entitlements.write_bytes(plistlib.dumps(signed))
        run("codesign", "--force", "--sign", identity, "--entitlements", str(entitlements),
            "--preserve-metadata=identifier,requirements,flags,runtime", "--generate-entitlement-der",
            "--timestamp=none", str(app))
        run("codesign", "--verify", "--deep", "--strict", str(app))
        require(plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(app))) == signed,
                "Signing changed the app entitlements.")
        require(signing_certificate(app, root / "prepared-cert") == identity, "Signing identity changed.")
        output = root / "prepared.ipa"
        run("ditto", "-c", "-k", str(unpacked), str(output))
        shutil.copymode(ipa, output)
        os.replace(output, ipa)

    checksum = hashlib.sha256()
    with ipa.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    print(json.dumps({"bundleIdentifier": bundle, "version": version, "buildNumber": build,
                      "teamIdentifier": team, "signingSHA1": identity, "ipaSha256": digest,
                      "privacyManifest": str(manifest)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Add the app privacy manifest and verify its App Store signature.")
    parser.add_argument("--ipa", required=True, type=Path)
    parser.add_argument("--identity", required=True, help="SHA-1 distribution signing identity")
    parser.add_argument("--manifest", type=Path,
                        default=Path(__file__).resolve().parents[1] / "release" / "PrivacyInfo.xcprivacy")
    args = parser.parse_args()
    try:
        prepare(args.ipa.resolve(), args.identity, args.manifest.resolve())
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        parser.exit(1, f"prepare-testflight: {error}\n")


if __name__ == "__main__":
    main()
