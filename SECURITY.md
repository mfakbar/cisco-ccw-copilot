# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security** tab by opening a private vulnerability report. Do not include credentials, customer data, quote details, or live CCW captures in a public issue.

## Repository hygiene

- Never commit CircuIT access tokens, application keys, companion session tokens, cookies, or browser profiles.
- Never commit customer names, RFPs, quote or deal identifiers, discounts, or unsanitized CCW pages.
- Supply `CIRCUIT_APP_KEY` only at runtime and keep local environment files untracked.
- Treat captured catalog fixtures as test data, not as current pricing, availability, or ordering guidance.

If a credential is committed, revoke or rotate it first, remove it from the complete Git history, and only then publish the repository.
