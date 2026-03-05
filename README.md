Mock WhatsApp pairing server

This mock server provides a simple HTTP API used by the admin UI for testing pairing and QR display.

Endpoints:
- GET /status -> { ok, server, paired, qr }
- POST /logout -> { ok }
- POST /simulate_pair -> { ok } (marks session as paired for testing)

Run:

```bash
cd wa-server
npm install
npm start
```

Default port: 31000
Webhook: https://modularconstruction.co.id/api/whatsapp_ai_webhook.php
