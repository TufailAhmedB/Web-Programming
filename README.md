# Smart Queue — College Office (v5.0)

A local college-office queue application with **separate student and staff portals and independent queues for each service**. The frontend uses HTML, CSS, and browser JavaScript; the backend uses Node.js, Express, Express Session, bcryptjs, and SQLite.

## Portals

- **Student portal:** `http://localhost:3000/` — create a token, see public queue status without other students' names, and look up a personal token using the token number and register number.
- **Staff portal:** `http://localhost:3000/admin` — staff sign-in, dashboard statistics, waiting list, private token records, search and filters, call-next, complete, skip, recall, and demo reset.

The student portal does not contain staff action buttons. Staff-only endpoints are protected by server-side session and role checks; hiding a button is not the security boundary.

## Requirements

- Node.js 14 or newer (Node.js 14 is end-of-life; use it only if required by your assessment).
- npm, included with Node.js.
- Internet access for the initial dependency installation, unless packages are already cached.

NVM is optional. On Windows PowerShell, check `node -v` and `npm -v`. If these commands are not recognized, install Node.js from <https://nodejs.org/> and restart PowerShell.

## Run on Windows / PowerShell

If you want to keep records from v3, copy your existing `queue.db` into this v5 project folder before the first start. The app adds the new queue-order and timing columns automatically. Keep a backup of the database before upgrading.

1. Extract the ZIP.
2. Open PowerShell in the extracted `smart-queue-college-office-v5` folder, where `package.json` is located.
3. Run:

```powershell
node -v
npm -v
npm install
npm test
npm start
```

4. Open `http://localhost:3000/` for students or `http://localhost:3000/admin` for staff.
5. Keep the terminal running while using the app.

## Demo staff credentials

For a first local demo, the application creates a staff account automatically if the configured username does not exist:

- Username: `admin`
- Password: `Admin@12345`

**Change the demo credentials before sharing or deploying the application.** Set environment variables before starting the server. Example in PowerShell:

```powershell
$env:ADMIN_USERNAME = "officeadmin"
$env:ADMIN_PASSWORD = "Use-A-Long-Unique-Password"
$env:SESSION_SECRET = "Replace-With-A-Long-Random-Secret"
npm start
```

These values are used to seed a new account and configure sessions. If `queue.db` already contains the `admin` account, changing the environment variables will not overwrite its password. For an existing database, use the current account or recreate the demo database only if you are comfortable losing its records. Do not use the demo credentials on an internet-accessible deployment.

## Features

### v5 real-world workflow improvements

- Guided service selection with a short description and preparation hints for each seeded service. These are general prompts; colleges should confirm exact document requirements before real use.
- Wait estimates are shown as a range (roughly 80%–130% of the service-based estimate), clearly marked as approximate rather than guaranteed.
- Clear no-show guidance explains that staff may skip a missed call and can requeue a skipped token at the end. This is a policy prompt, not an automatic grace-period timer.
- Staff can issue walk-in tokens through the staff portal; walk-ins join the same service queue and use the same duplicate-active-token validation.
- Staff can pause or resume individual services. Paused services remain visible but cannot accept new student tokens; existing queue records are preserved.

### Student portal

- Generate sequential tokens such as `A001` with name, register number, department, service, and optional notes.
- Prevent a second active token for the same register number.
- Select a service to view its current token, waiting count, last token issued, and approximate waiting time.
- Look up an individual token with both token number and register number.
- Automatic public queue refresh every five seconds.
- Recall announcements appear on the public display for the currently serving token.
- After issuing a token, the live display switches to that token’s service queue.
- Public queue data intentionally omits student names, register numbers, and descriptions.

### Staff portal

- Username/password sign-in with bcrypt-hashed passwords and HTTP-only, same-site session cookie.
- Server-protected queue operations and private token-record endpoints.
- Service selector: each service has its own current token, waiting list, counts, and queue advancement.
- Calling next for one service does not advance another service queue.
- Waiting positions are calculated within the selected service queue; requeued skipped tokens return to the end.
- Waiting-time estimates use the average recorded service duration for that service when available, with a five-minute fallback.
- Waiting-list view with student details.
- Search by token number, name, or register number; filter by service/status; load more records.
- Call next, complete, skip, requeue a skipped token, recall the selected service’s current token, and reset demo queue (reset requires typing `RESET`).
- Staff dashboard refreshes automatically while signed in.

### Database and safety

- SQLite database and tables are initialized automatically, with additive migrations for service queue order and service-duration timestamps.
- Token numbers remain globally unique, while waiting order and queue advancement are isolated by service.
- Existing token tables receive additive column migrations.
- Parameterized SQL queries, server-side input validation, security response headers, and serialized queue mutations.
- Staff passwords are stored as bcrypt hashes, not plain text.

## API overview

| Method | Route | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | Public | Health check |
| `POST` | `/api/auth/login` | Public | Staff sign-in |
| `GET` | `/api/auth/me` | Session status | Check signed-in staff |
| `POST` | `/api/auth/logout` | Session | Sign out |
| `GET` | `/api/services` | Public | Active service list |
| `GET` | `/api/queue` | Public, sanitized | Queue summary without student details |
| `POST` | `/api/tokens` | Public | Issue a student token |
| `GET` | `/api/lookup` | Public, requires matching token and register number | Personal token status |
| `GET` | `/api/admin/queue` | Staff only | Full queue and statistics |
| `GET` | `/api/admin/tokens` | Staff only | Searchable private records |
| `POST` | `/api/admin/next` | Staff only | Call next token |
| `POST` | `/api/admin/services/pause` | Staff only | Pause/resume a service queue |
| `POST` | `/api/admin/tokens/:id/complete` | Staff only | Complete a serving token |
| `POST` | `/api/admin/tokens/:id/skip` | Staff only | Skip a token |
| `POST` | `/api/admin/recall` | Staff only | Recall selected service current token |
| `POST` | `/api/admin/tokens/:id/requeue` | Staff only | Return a skipped token to the end of its service queue |
| `POST` | `/api/admin/reset` | Staff only | Reset demo records |

## Project structure

```text
smart-queue-college-office/
├── server.js
├── package.json
├── README.md
├── queue.db              # created on first start; not included in the ZIP
└── public/
    ├── index.html        # student portal
    ├── app.js            # student portal logic
    ├── admin.html        # staff sign-in and dashboard
    ├── admin.js          # staff portal logic
    └── style.css         # shared styles
```

## Testing checklist

1. Run `npm test` and confirm syntax checks pass.
2. Start the server with `npm start`.
3. Open `/` and verify no staff action buttons or student-record table appears.
4. Issue a token and verify the receipt appears.
5. Open `/admin` and sign in with the configured staff credentials.
6. Open `/api/admin/queue` in a logged-out browser session; it should return HTTP 401.
7. Sign in and verify queue controls and student records work.
8. Try wrong credentials and verify access is denied.
9. Confirm public `/api/queue` does not return student names or register numbers.
10. Pause a service and verify new tokens are blocked while its existing queue remains visible; resume it and verify issuance works.
11. Issue a walk-in token in the staff portal and verify it appears in the same queue as online tokens.
12. Create tokens for two different services and verify each service has its own waiting count and current token.
13. Call next in one service and verify the other service queue is unchanged.
14. Skip and requeue a token; verify it returns to the end of its own service queue.
15. Call, complete, and recall tokens; verify status changes persist after refresh and recall appears on the public display.
16. Verify the student token lookup works only with matching token and register number.
17. Test reset confirmation and the mobile layout.

## Limitations

- Service guidance is illustrative and must be customized to the actual college policy.
- The no-show grace period is communicated as guidance but is not enforced by a timer.
- Walk-in token creation is staff-assisted but currently uses the same token endpoint and active-token rules as online requests.
- Wait ranges are simple estimates, not statistical confidence intervals.

The token label sequence is globally unique (for example, `A001`, `A002`) rather than restarting for each service; each service still has an independent waiting line and serving token. The queue is designed for one local server process.

This is an educational local prototype, not a production deployment. Express's default in-memory session store is intended for local assessment use and is not appropriate for a multi-process production server. Waiting-time estimates are approximate and use recorded completed service durations per service where available, with a five-minute fallback. Before real deployment, add a persistent session store, CSRF protection, login rate limiting, stronger operational controls, HTTPS, and a privacy review. Do not store real student data or expose this demo publicly without additional security work.
