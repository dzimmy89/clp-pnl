#!/usr/bin/env bash
# Runs in Cloud Shell right after the "Run on Google Cloud" button has built and deployed the
# service. Finishes the setup the button cannot do on its own: Cloud SQL (unless DATABASE_URL
# was typed in), Secret Manager, the runtime service account, AUTH_DOMAIN, and the Cloud Build
# trigger that redeploys on every push. The button exports GOOGLE_CLOUD_PROJECT,
# GOOGLE_CLOUD_REGION and K_SERVICE, and leaves the env vars the person typed in the shell.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ] || [ -z "${K_SERVICE:-}" ]; then
  echo "Not running under the Cloud Run button; run ./deploy/gcp-setup.sh with PROJECT_ID set instead."
  exit 0
fi

export PROJECT_ID="$GOOGLE_CLOUD_PROJECT"
export REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
export SERVICE="$K_SERVICE"
export SKIP_BUILD=1
# The button already deployed the image, so only the surrounding setup runs. A failure here
# leaves a working service without accounts; the message says what to run by hand.
if ./deploy/gcp-setup.sh; then
  exit 0
fi
cat <<MSG

The service is deployed, but part of the follow-up setup did not finish. From this Cloud Shell, run:
  PROJECT_ID=$PROJECT_ID REGION=$REGION SERVICE=$SERVICE SKIP_BUILD=1 ./deploy/gcp-setup.sh
MSG
exit 0
