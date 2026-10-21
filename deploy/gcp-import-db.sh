#!/usr/bin/env bash
# Copy an existing Postgres (the old Neon database, for example) into the app's Cloud SQL
# database, replacing whatever tables are there. Run it from Cloud Shell after gcp-setup.sh:
#   SOURCE_DATABASE_URL='postgresql://...' PROJECT_ID=my-project ./deploy/gcp-import-db.sh
#
# It dumps the source with pg_dump (from the postgres Docker image, so the client is new enough
# for any source), uploads the dump to a temporary bucket, imports it with `gcloud sql import`
# as the app's database user so the app owns the tables, then deletes the bucket.
#
# Settings: SOURCE_DATABASE_URL and PROJECT_ID (required), REGION (us-central1),
# SQL_INSTANCE (omnifolio-db), SQL_DATABASE (omnifolio), SQL_USER (omnifolio), PG_IMAGE (postgres:18).
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL to the connection string of the database to copy}"
: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
SQL_INSTANCE="${SQL_INSTANCE:-omnifolio-db}"
SQL_DATABASE="${SQL_DATABASE:-omnifolio}"
SQL_USER="${SQL_USER:-omnifolio}"
PG_IMAGE="${PG_IMAGE:-postgres:18}"
BUCKET="gs://${PROJECT_ID}-db-import-$(date +%s)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT_ID" >/dev/null

say "1/3 Dump the source database"
# --clean --if-exists drops the empty tables the app may already have created on Cloud SQL.
docker run --rm -e SOURCE_DATABASE_URL "$PG_IMAGE" \
  sh -c 'pg_dump "$SOURCE_DATABASE_URL" --schema=public --clean --if-exists --no-owner --no-privileges --format=plain' \
  >"$WORK/raw.sql"
# Cloud SQL's importer runs plain SQL: drop psql meta-commands (\restrict) and settings that an
# older server would reject. No `sed -i`, which differs between GNU and macOS.
sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^SET transaction_timeout/d' "$WORK/raw.sql" >"$WORK/dump.sql"
echo "  $(wc -c <"$WORK/dump.sql") bytes, $(grep -c '^COPY ' "$WORK/dump.sql" || true) tables with data"

say "2/3 Upload it to a temporary bucket"
gcloud storage buckets create "$BUCKET" --location="$REGION" --uniform-bucket-level-access >/dev/null
trap 'gcloud storage rm -r "$BUCKET" --quiet >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
gcloud storage cp "$WORK/dump.sql" "$BUCKET/dump.sql" >/dev/null
SQL_SA="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(serviceAccountEmailAddress)')"
gcloud storage buckets add-iam-policy-binding "$BUCKET" \
  --member="serviceAccount:${SQL_SA}" --role=roles/storage.objectViewer >/dev/null

say "3/3 Import into Cloud SQL"
gcloud sql import sql "$SQL_INSTANCE" "$BUCKET/dump.sql" \
  --database="$SQL_DATABASE" --user="$SQL_USER" --quiet

echo
echo "Imported into ${SQL_INSTANCE}/${SQL_DATABASE}. Sign in to the app to check your account and saved wallets."
