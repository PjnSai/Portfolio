# Security

This site is built to be secure by design. The design is public on purpose: nothing here depends on the design staying secret. Only keys and credentials are secret, and they are never stored in this repository.

## Reporting a problem

Please report suspected vulnerabilities privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Please include the affected URL or file, the steps to reproduce, and what you expected to happen. You should get a reply within seven days. Please do not run automated scanners or load tests against the live site.

## What to read

- `docs/THREAT-MODEL.md`: what is protected, from whom, and how.
- `docs/OWASP-MAP.md`: each OWASP Top 10 (2025) item mapped to its control and test.
- `docs/DECISIONS.md`: design decisions and their reasons.

## Ground rules of the design

- Authentication, writes, uploads, forms and the admin area fail closed. Public pages fail static.
- The API denies requests by default; each public endpoint is opened explicitly.
- The built-in Django admin is not installed.
- Errors never show stack traces, SQL, file paths or versions.
- Containers run as a non-root user on a read-only filesystem.
- Dependencies are pinned (lockfile for npm, hashes for pip) and checked on every pull request.
- No visitor accounts, and no personal data stored beyond contact messages.
