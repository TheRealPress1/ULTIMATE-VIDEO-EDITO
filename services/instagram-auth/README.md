# UVE Instagram authorization service

This optional Node service enables the desktop **Sign in with Instagram** button. It is implemented and tested with simulated Meta responses; it has not been deployed or authorized against a live account. Desktop editing and the developer-token connection work without it. No app secret belongs in the desktop bundle, renderer, chat, project folder, or public build configuration.

## Deployment

1. Provision a public HTTPS origin you control, such as `https://auth.your-domain.example`. Run one instance behind a TLS reverse proxy. The process binds `127.0.0.1:8080` by default; the Docker image binds its container interface. Keep the backend port private.
2. Configure Instagram API with Instagram Login in your Meta app. Register the exact callback `https://auth.your-domain.example/v1/instagram/callback`. Request `instagram_business_basic`, `instagram_business_manage_insights`, and `instagram_business_content_publish`; Meta roles, permissions, and app review must allow the professional account used. Configure any required privacy/deletion/contact URLs in your Meta dashboard before public distribution.
3. Supply server environment values through the host's secret/config manager: `PUBLIC_URL` is the HTTPS origin, `INSTAGRAM_APP_ID` is the Instagram app ID, and `INSTAGRAM_APP_SECRET` is the server-only app secret. Optional `HOST`/`PORT` control the internal bind. Start with `npm start` in this directory or build this directory's Dockerfile. No dependency install is needed.
4. Set the public, nonsecret `UVE_INSTAGRAM_AUTH_URL` to the same HTTPS origin when building UVE. The build writes it into `dist/release-config.json` for Finder launches; a runtime environment override is also supported. Leave it unset to keep browser sign-in visibly disabled. Never put the app secret in this variable.
5. Check `/health`. Then perform a deliberate live sign-in with an authorized test account and inspect the connected account in UVE. Publishing needs a separate explicit draft approval. Automated tests do not validate your app's actual permissions or current Meta account state.

Do not enable request URL/body logging at the reverse proxy, service, APM, or outbound HTTP tracing. Callback URLs contain single-use codes; Meta's long-lived-token exchange uses query parameters containing credentials. Add ingress rate limits and appropriate request/connection limits. The service applies a bounded in-memory session cap and a conservative per-socket-address rate limit; it deliberately does not trust forwarded IP headers. Behind one proxy that limit covers the proxy's combined traffic, so tune deployment ingress/load accordingly before broad distribution.

## Flow and bounds

The desktop creates a random verifier and sends only its SHA-256 challenge to `/v1/instagram/start`. The broker creates independent random state and returns the fixed Instagram authorization URL. The HTTPS callback consumes that state once, exchanges the code through fixed Meta endpoints, and holds the long-lived user token in memory. `/v1/instagram/redeem` requires the desktop verifier; a ready token can be redeemed only once. This is an application-level desktop binding, not a claim that Meta implements PKCE for this flow.

Tokens never appear in callback HTML or redirects. The desktop main process immediately hands the redeemed token to the existing OS-encrypted credential connection; it does not return it to the renderer or MCP. Sessions expire after ten minutes, with a maximum of 1,000 live flows. Bodies and upstream responses are size-bounded, redirects are disabled, and exchanges time out. Cancellation, denial, expiry and service restart require starting sign-in again. The initial service uses memory, so deploy a single replica; horizontal scaling requires a shared atomic, expiring session store and single-use redemption.

`npm test` runs the broker's offline contract and security tests. Do not use personal credentials in these tests. The service does not host media or perform Instagram publishing.

## API references and live validation

- [Instagram Login documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/)
- [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Content publishing documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/)

Meta's developer pages returned HTTP 429 in this implementation session. Its official Postman collection confirmed Instagram Login professional-account scopes and public-URL publishing concepts. The code uses pinned Instagram authorization/token endpoints and Graph v24.0; verify your configured callback, granted scopes, token exchange and Reel publication in a controlled live acceptance test before claiming production activation.
