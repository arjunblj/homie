# Security

Report vulnerabilities via [GitHub Security Advisories](https://github.com/arjunblj/homie/security/advisories/new). Don't open a public issue.

- Shell tool is off by default
- Fetched content is XML-isolated so the model can tell it apart from instructions
- API keys go in `.env` (gitignored)
- Docker image runs as non-root
