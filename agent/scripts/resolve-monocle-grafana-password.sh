#!/usr/bin/env bash
set -euo pipefail

project_root="/home/colin/devpod-repos/DefaceRoot/CISEN-Dashboard"
vault_file="${project_root}/group_vars/vault.yml"
vault_pass_file="${project_root}/vault_pass.txt"

ansible-vault view "${vault_file}" --vault-password-file "${vault_pass_file}" | python3 -c '
import sys
import yaml

data = yaml.safe_load(sys.stdin.read()) or {}
# Try common vault variable names for Grafana admin password
for key in ["vault_grafana_admin_password", "vault_grafana_password", "grafana_admin_password"]:
    value = data.get(key, "")
    if isinstance(value, str) and value.strip():
        print(value.strip())
        sys.exit(0)
# Fallback to admin if no password found
print("admin")
'
