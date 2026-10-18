#!/usr/bin/env bash
# One-time setup of Omnifolio on Google Cloud Run, deploying from the GitHub repo.
#
# Run it once, signed in as the account that owns the project:
#   gcloud auth login hello@defiuniversity.xyz
#   PROJECT_ID=my-project ./deploy/gcp-setup.sh
#
# What it does (each step is safe to run again):
#   1. Enables the APIs and creates an Artifact Registry repository for the image.
#   2. Creates a Cloud SQL Postgres instance, database and user, unless DATABASE_URL is given
#      (for example a Neon connection string).
#   3. Stores DATABASE_URL and every API key you exported as Secret Manager secrets.
#   4. Creates the runtime service account and gives Cloud Build the right to deploy.
#   5. Builds and deploys the service, then pins AUTH_DOMAIN to its public host.
#   6. Creates the Cloud Build trigger that redeploys on every push to the branch.
#
# Settings (environment variables, all optional except PROJECT_ID):
#   PROJECT_ID        Google Cloud project id (required)
#   REGION            Cloud Run and Cloud SQL region            (default us-central1)
#   SERVICE           Cloud Run service name                    (default omnifolio)
#   REPOSITORY        Artifact Registry repository              (default omnifolio)
#   GITHUB_OWNER      GitHub owner of the repo                  (default dzimmy89)
#   GITHUB_REPO       GitHub repository name                    (default clp-pnl)
#   BRANCH            Branch that deploys to production         (default main)
#   DATABASE_URL      Use this Postgres instead of Cloud SQL    (optional)
#   SQL_INSTANCE      Cloud SQL instance name                   (default omnifolio-db)
#   SQL_TIER          Cloud SQL machine tier                    (default db-f1-micro)
#   AUTH_DOMAIN       Custom domain to pin sign-in to, if any   (default: the run.app host)
#   ZERION_API_KEY, ALCHEMY_API_KEY, COINGECKO_API_KEY, OWNER_WALLETS, OWNER_READ_TOKEN,
#   TONAPI_KEY, TONCENTER_API_KEY, TRONGRID_API_KEY, APTOS_API_KEY, KOIOS_API_KEY, JUPITER_API_KEY,
#   ARBITRUM_RPC_URL, SOLANA_RPC_URL, SUI_RPC_URL, STARKNET_RPC_URL,
#   RPC_URL_ETHEREUM, RPC_URL_BASE, RPC_URL_ARBITRUM, RPC_URL_BNB, RPC_URL_ROBINHOOD, RPC_URL_ARC
#                     Stored as secrets when set
#   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
#                     Baked into the build for the WalletConnect button (optional)
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-omnifolio}"
REPOSITORY="${REPOSITORY:-omnifolio}"
GITHUB_OWNER="${GITHUB_OWNER:-dzimmy89}"
GITHUB_REPO="${GITHUB_REPO:-clp-pnl}"
BRANCH="${BRANCH:-main}"
SQL_INSTANCE="${SQL_INSTANCE:-omnifolio-db}"
SQL_TIER="${SQL_TIER:-db-f1-micro}"
SQL_DATABASE="omnifolio"
SQL_USER="omnifolio"
RUNTIME_SA="${SERVICE}-run"
WALLETCONNECT="${NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID:-}"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1;33m== %s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"

say "1/6 APIs and Artifact Registry"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com
gcloud artifacts repositories describe "$REPOSITORY" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPOSITORY" --location="$REGION" --repository-format=docker \
    --description="Omnifolio images"

say "2/6 Database"
SQL_CONNECTION=""
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Using the DATABASE_URL you provided; Cloud SQL is skipped."
else
  if ! gcloud sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    gcloud sql instances create "$SQL_INSTANCE" \
      --database-version=POSTGRES_16 \
      --edition=ENTERPRISE \
      --tier="$SQL_TIER" \
      --region="$REGION" \
      --storage-size=10GB \
      --storage-auto-increase \
      --availability-type=zonal
  fi
  gcloud sql databases describe "$SQL_DATABASE" --instance="$SQL_INSTANCE" >/dev/null 2>&1 ||
    gcloud sql databases create "$SQL_DATABASE" --instance="$SQL_INSTANCE"
  SQL_CONNECTION="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
  if gcloud secrets describe DATABASE_URL >/dev/null 2>&1 && gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$SQL_USER"; then
    echo "Database user and DATABASE_URL secret already exist; keeping them."
  else
    SQL_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
    if gcloud sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$SQL_USER"; then
      gcloud sql users set-password "$SQL_USER" --instance="$SQL_INSTANCE" --password="$SQL_PASSWORD"
    else
      gcloud sql users create "$SQL_USER" --instance="$SQL_INSTANCE" --password="$SQL_PASSWORD"
    fi
    DATABASE_URL="postgresql://${SQL_USER}:${SQL_PASSWORD}@localhost/${SQL_DATABASE}?host=/cloudsql/${SQL_CONNECTION}"
  fi
fi

say "3/6 Secrets"
put_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || return 0
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
  fi
  echo "  stored $name"
}
SECRET_NAMES=(DATABASE_URL ZERION_API_KEY ALCHEMY_API_KEY COINGECKO_API_KEY OWNER_WALLETS OWNER_READ_TOKEN
  TONAPI_KEY TONCENTER_API_KEY TRONGRID_API_KEY APTOS_API_KEY KOIOS_API_KEY JUPITER_API_KEY
  ARBITRUM_RPC_URL SOLANA_RPC_URL SUI_RPC_URL STARKNET_RPC_URL
  RPC_URL_ETHEREUM RPC_URL_BASE RPC_URL_ARBITRUM RPC_URL_BNB RPC_URL_ROBINHOOD RPC_URL_ARC)
for name in "${SECRET_NAMES[@]}"; do
  put_secret "$name" "${!name:-}"
done
SECRET_FLAGS=""
for name in "${SECRET_NAMES[@]}"; do
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    SECRET_FLAGS="${SECRET_FLAGS:+$SECRET_FLAGS,}${name}=${name}:latest"
  fi
done

say "4/6 Service accounts"
RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUNTIME_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$RUNTIME_SA" --display-name="Omnifolio Cloud Run runtime"
for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUNTIME_EMAIL}" --role="$role" --condition=None >/dev/null
done
# Cloud Build runs as the compute default service account in new projects; let it push images and deploy.
BUILD_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/run.admin roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${BUILD_EMAIL}" --role="$role" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
  --member="serviceAccount:${BUILD_EMAIL}" --role=roles/iam.serviceAccountUser >/dev/null
# Older projects still build as the legacy Cloud Build service account; give it the same rights when it exists.
LEGACY_BUILD_EMAIL="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
if gcloud iam service-accounts describe "$LEGACY_BUILD_EMAIL" >/dev/null 2>&1; then
  for role in roles/run.admin roles/artifactregistry.writer; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${LEGACY_BUILD_EMAIL}" --role="$role" --condition=None >/dev/null || true
  done
  gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_EMAIL" \
    --member="serviceAccount:${LEGACY_BUILD_EMAIL}" --role=roles/iam.serviceAccountUser >/dev/null || true
fi

say "5/6 First build and deploy"
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_SERVICE=${SERVICE},_REPOSITORY=${REPOSITORY},_WALLETCONNECT_PROJECT_ID=${WALLETCONNECT},_TAG=$(git rev-parse --short HEAD 2>/dev/null || echo manual)" .
UPDATE_ARGS=(
  --region="$REGION"
  --service-account="$RUNTIME_EMAIL"
  --allow-unauthenticated
  --cpu=1 --memory=1Gi --concurrency=40
  --min-instances=0 --max-instances=3
  --timeout=300
  --port=8080
)
[ -n "$SQL_CONNECTION" ] && UPDATE_ARGS+=(--add-cloudsql-instances="$SQL_CONNECTION")
[ -n "$SECRET_FLAGS" ] && UPDATE_ARGS+=(--update-secrets="$SECRET_FLAGS")
gcloud run services update "$SERVICE" "${UPDATE_ARGS[@]}"
URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
HOST="${AUTH_DOMAIN:-${URL#https://}}"
gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="AUTH_DOMAIN=${HOST},NODE_ENV=production" >/dev/null
echo "Deployed: $URL (sign-in pinned to $HOST)"

say "6/6 GitHub trigger"
if gcloud builds triggers describe "${SERVICE}-${BRANCH}" --region="$REGION" >/dev/null 2>&1; then
  echo "Trigger ${SERVICE}-${BRANCH} already exists."
elif gcloud builds triggers create github \
  --name="${SERVICE}-${BRANCH}" \
  --region="$REGION" \
  --repo-owner="$GITHUB_OWNER" \
  --repo-name="$GITHUB_REPO" \
  --branch-pattern="^${BRANCH}\$" \
  --build-config=cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_SERVICE=${SERVICE},_REPOSITORY=${REPOSITORY},_WALLETCONNECT_PROJECT_ID=${WALLETCONNECT}" 2>/dev/null; then
  echo "Every push to ${BRANCH} on ${GITHUB_OWNER}/${GITHUB_REPO} now builds and deploys."
else
  cat <<MSG
Could not create the trigger automatically: the Cloud Build GitHub App must be connected to
${GITHUB_OWNER}/${GITHUB_REPO} first. Connect it at
  https://console.cloud.google.com/cloud-build/triggers;region=${REGION}/connect?project=${PROJECT_ID}
then run this script again (every other step is already done and will be skipped).
MSG
fi

cat <<MSG

Done. Check the deployment:
  curl ${URL}/api/health
Change a setting later with, for example:
  gcloud run services update ${SERVICE} --region=${REGION} --update-secrets=ZERION_API_KEY=ZERION_API_KEY:latest
  gcloud run services update ${SERVICE} --region=${REGION} --update-env-vars=AUTH_DOMAIN=portfolio.defiuniversity.xyz
MSG
