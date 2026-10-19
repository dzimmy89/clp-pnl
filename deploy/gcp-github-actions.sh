#!/usr/bin/env bash
# Lets GitHub Actions deploy this repository to Cloud Run without any stored key: a deployer
# service account that GitHub's OIDC token can impersonate (Workload Identity Federation),
# limited to this one repository. Run once, after ./deploy/gcp-setup.sh, signed in as the owner:
#
#   PROJECT_ID=my-project ./deploy/gcp-github-actions.sh
#
# It prints the three repository secrets to add (and the `gh secret set` commands). After that,
# every push to main runs .github/workflows/deploy.yml.
#
#   PROJECT_ID      Google Cloud project id (required)
#   GITHUB_OWNER    GitHub owner of the repo        (default dzimmy89)
#   GITHUB_REPO     GitHub repository name          (default clp-pnl)
#   SERVICE         Cloud Run service name          (default omnifolio)
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project id}"
GITHUB_OWNER="${GITHUB_OWNER:-dzimmy89}"
GITHUB_REPO="${GITHUB_REPO:-clp-pnl}"
SERVICE="${SERVICE:-omnifolio}"
POOL="github"
PROVIDER="github"
DEPLOYER="${SERVICE}-deployer"

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
REPO="${GITHUB_OWNER}/${GITHUB_REPO}"

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com cloudbuild.googleapis.com >/dev/null

echo "== Deployer service account"
gcloud iam service-accounts describe "$DEPLOYER_EMAIL" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$DEPLOYER" --display-name="GitHub Actions deployer for ${SERVICE}"
# Submit builds, upload the source to the Cloud Build bucket, read the build logs, read the service URL.
for role in roles/cloudbuild.builds.editor roles/storage.objectAdmin roles/viewer roles/run.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEPLOYER_EMAIL}" --role="$role" --condition=None >/dev/null
done
# Builds run as the Cloud Build account (the compute default in new projects, which gcp-setup.sh already allows to deploy).
BUILD_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding "$BUILD_EMAIL" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" --role=roles/iam.serviceAccountUser >/dev/null || true

echo "== Workload Identity pool and GitHub provider"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global \
    --workload-identity-pool="$POOL" \
    --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository == '${REPO}'"
fi
PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

echo "== Let workflows from ${REPO} impersonate the deployer"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

cat <<MSG

Done. Add these repository secrets on GitHub (Settings → Secrets and variables → Actions):

  GCP_PROJECT_ID                   ${PROJECT_ID}
  GCP_WORKLOAD_IDENTITY_PROVIDER   ${PROVIDER_NAME}
  GCP_SERVICE_ACCOUNT              ${DEPLOYER_EMAIL}

Or with the GitHub CLI:
  gh secret set GCP_PROJECT_ID --repo ${REPO} --body "${PROJECT_ID}"
  gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER --repo ${REPO} --body "${PROVIDER_NAME}"
  gh secret set GCP_SERVICE_ACCOUNT --repo ${REPO} --body "${DEPLOYER_EMAIL}"

Then push to main, or run the "Deploy to Cloud Run" workflow from the Actions tab.
MSG
