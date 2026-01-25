#!/bin/bash
# Ansible vault password script for 1Password integration
# This script echoes the ANSIBLE_VAULT_PASSWORD environment variable
# Used with: ansible-playbook --vault-password-file=./vault-password.sh
#
# The password is injected at runtime via:
#   op run --env-file=.env.op -- ansible-playbook ...

if [ -z "${ANSIBLE_VAULT_PASSWORD}" ]; then
    echo "ERROR: ANSIBLE_VAULT_PASSWORD environment variable is not set" >&2
    echo "Run via: op run --env-file=.env.op -- ansible-playbook ..." >&2
    exit 1
fi

echo "${ANSIBLE_VAULT_PASSWORD}"
