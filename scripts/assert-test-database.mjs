const testUrl = process.env.DATABASE_URL_TEST;
const applicationUrl = process.env.DATABASE_URL;

function fail(reason) {
  console.error(`Refusing database test setup: ${reason}`);
  process.exit(1);
}

if (!testUrl) fail("DATABASE_URL_TEST is required.");
if (applicationUrl && testUrl === applicationUrl) {
  fail("DATABASE_URL_TEST must differ from DATABASE_URL.");
}

let parsed;
try {
  parsed = new URL(testUrl);
} catch {
  fail("DATABASE_URL_TEST must be a valid PostgreSQL URL.");
}

if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
  fail("DATABASE_URL_TEST must use the PostgreSQL protocol.");
}
if (parsed.hostname !== "127.0.0.1" || parsed.port !== "5433") {
  fail("DATABASE_URL_TEST must target 127.0.0.1:5433.");
}

const databaseName = decodeURIComponent(parsed.pathname.slice(1));
if (!databaseName.endsWith("_test")) {
  fail("DATABASE_URL_TEST must name a database ending in _test.");
}
