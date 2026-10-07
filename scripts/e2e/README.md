# Test backend for the Android app

`server.cjs` lets you try the app on an emulator or a phone **without touching production, Neon or any real money**. It runs
the real route handlers on an in-memory database with a simulated chain, seeds demo data, and forwards everything else to
`https://www.bluvfi.xyz`. See the comment at the top of the file for the controls.

```bash
# 1. the backend (needs PGlite, see ../tests/README.md)
PGLITE_PATH=<folder with @electric-sql/pglite> node scripts/e2e/server.cjs        # listens on :3100

# 2. in the app repo, point the dev server at it (10.0.2.2 is the host as seen from the Android emulator)
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3100 npx expo start --dev-client --port 8082
```

The signed-in user is treated as an admin with some commission, Shar, providers (free, paid, in review, paused) and a waiting
claim and withdrawal, so every screen has something to show. Its state resets each time it starts.
