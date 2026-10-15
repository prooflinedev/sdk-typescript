"""Admit a release only at its package version and a commit on main."""
import json
import os
from pathlib import Path
import re
import subprocess

version = json.loads(Path("package.json").read_text())["version"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit("package version must be x.y.z")
ref = os.environ["GITHUB_REF"]
if ref not in ("refs/heads/main", f"refs/tags/v{version}"):
    raise SystemExit("release requires main or a tag equal to the package version")
subprocess.run(["git", "fetch", "--quiet", "origin", "main"], check=True)
subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], check=True)
api = json.loads(Path("openapi.public.json").read_text())["info"]["version"]
package_parts = tuple(map(int, version.split(".")))
api_parts = tuple(map(int, api.split(".")))
if package_parts[:2] != api_parts[:2] or package_parts[2] < api_parts[2]:
    raise SystemExit("SDK must follow the public API major/minor and not precede its patch")
with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
    output.write(f"version={version}\n")
print(f"Release version: {version}")
