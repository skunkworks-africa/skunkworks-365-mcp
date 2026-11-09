# Contributing

We welcome focused pull requests to the public Skunkworks 365 MCP project.

1. Open an issue describing scope, threat boundaries and acceptance criteria.
2. Work on a dedicated feature branch and include tests for authorization, error handling and tenant isolation.
3. Run `npm install --ignore-scripts` and `npm test` using Node.js 24+.
4. Submit a PR with a reproducible test plan. Auth and write-operation changes require additional security review.

Never commit credentials, actual customer tenants, invoices, personal data, .env files or commercial contracts. Approval flags provided by a model are not authority to execute customer changes.

Source is MIT licensed under [LICENSE](LICENSE).
