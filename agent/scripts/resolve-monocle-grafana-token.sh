#!/usr/bin/env bash
set -euo pipefail

project_root="/home/colin/devpod-repos/DefaceRoot/CISEN-Dashboard"
vault_file="${project_root}/group_vars/vault.yml"
vault_pass_file="${project_root}/vault_pass.txt"

ansible-vault view "${vault_file}" --vault-password-file "${vault_pass_file}" | python3 -c '
import sys
import yaml

data = yaml.safe_load(sys.stdin.read()) or {}
value = data.get("vault_grafana_api_key", "")
if not isinstance(value, str) or not value.strip():
    raise SystemExit(1)
print(value.strip())
'
