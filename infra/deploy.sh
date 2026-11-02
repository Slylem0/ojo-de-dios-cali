#!/usr/bin/env bash
# Deploys Ojo de Dios: Cali with plain AWS CLI (idempotent, re-runnable).
#   ./infra/deploy.sh backend   -> S3 bucket, Lambda + Function URL, EventBridge recorder
#   ./infra/deploy.sh location  -> Amazon Location API key (maps + places)
#   ./infra/deploy.sh cdn       -> CloudFront distribution (OAC) in front of the bucket
#   ./infra/deploy.sh site      -> writes web/config.js and uploads web/ to S3
#   ./infra/deploy.sh all
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${AWS_REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
APP=ojo-de-dios-cali
BUCKET=${BUCKET:-$APP-$ACCOUNT}
FN=$APP-aircraft
ROLE=$APP-lambda-role
RULE=$APP-recorder
KEY_NAME=$APP-key
STATE=infra/.state
mkdir -p "$STATE"
export AWS_REGION=$REGION AWS_PAGER=""

backend() {
  if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
    echo "bucket $BUCKET created"
  fi

  if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
      "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "role $ROLE created, waiting for propagation"; sleep 10
  fi
  aws iam put-role-policy --role-name "$ROLE" --policy-name s3-snapshots --policy-document "{
    \"Version\":\"2012-10-17\",\"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/data/*\"},
      {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::$BUCKET\",\"Condition\":{\"StringLike\":{\"s3:prefix\":\"data/*\"}}}]}"

  (cd backend && rm -f ../infra/.state/fn.zip && zip -q ../infra/.state/fn.zip index.mjs)
  if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$FN" --zip-file fileb://$STATE/fn.zip >/dev/null
  else
    aws lambda create-function --function-name "$FN" --runtime nodejs22.x --handler index.handler \
      --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file fileb://$STATE/fn.zip \
      --timeout 20 --memory-size 256 --environment "Variables={BUCKET=$BUCKET}" >/dev/null
    aws lambda wait function-active-v2 --function-name "$FN"
  fi

  if ! aws lambda get-function-url-config --function-name "$FN" >/dev/null 2>&1; then
    aws lambda create-function-url-config --function-name "$FN" --auth-type NONE \
      --cors 'AllowOrigins=["*"],AllowMethods=["GET"],MaxAge=3600' >/dev/null
    aws lambda add-permission --function-name "$FN" --statement-id public-url \
      --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE >/dev/null
    aws lambda add-permission --function-name "$FN" --statement-id public-url-invoke \
      --action lambda:InvokeFunction --principal "*" >/dev/null 2>&1 || true
  fi
  aws lambda get-function-url-config --function-name "$FN" --query FunctionUrl --output text > "$STATE/api_url"

  RULE_ARN=$(aws events put-rule --name "$RULE" --schedule-expression "rate(1 minute)" --query RuleArn --output text)
  aws lambda add-permission --function-name "$FN" --statement-id events-recorder \
    --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 || true
  aws events put-targets --rule "$RULE" \
    --targets "Id=1,Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$FN" >/dev/null
  echo "api: $(cat $STATE/api_url)"
}

location() {
  local referers='["https://*.cloudfront.net/*","http://localhost:*/*","http://127.0.0.1:*/*"]'
  if ! aws location describe-key --key-name "$KEY_NAME" >/dev/null 2>&1; then
    aws location create-key --key-name "$KEY_NAME" --no-expiry --restrictions "{
      \"AllowActions\":[\"geo-maps:*\",\"geo-places:*\"],
      \"AllowResources\":[\"arn:aws:geo-maps:$REGION::provider/default\",\"arn:aws:geo-places:$REGION::provider/default\"],
      \"AllowReferers\":$referers}" >/dev/null
  fi
  aws location describe-key --key-name "$KEY_NAME" --query Key --output text > "$STATE/location_key"
  echo "location key ready"
}

cdn() {
  if [[ -s $STATE/cdn_id ]]; then echo "cdn exists: $(cat $STATE/cdn_domain)"; return; fi
  OAC_ID=$(aws cloudfront create-origin-access-control --origin-access-control-config "{
    \"Name\":\"$APP-oac\",\"SigningProtocol\":\"sigv4\",\"SigningBehavior\":\"always\",\"OriginAccessControlOriginType\":\"s3\"}" \
    --query OriginAccessControl.Id --output text)
  read -r CDN_ID CDN_DOMAIN < <(aws cloudfront create-distribution --distribution-config "{
    \"CallerReference\":\"$APP-$(date +%s)\",\"Comment\":\"$APP\",\"Enabled\":true,\"DefaultRootObject\":\"index.html\",
    \"Origins\":{\"Quantity\":1,\"Items\":[{\"Id\":\"site\",\"DomainName\":\"$BUCKET.s3.$REGION.amazonaws.com\",\"OriginPath\":\"/site\",
      \"S3OriginConfig\":{\"OriginAccessIdentity\":\"\"},\"OriginAccessControlId\":\"$OAC_ID\"}]},
    \"DefaultCacheBehavior\":{\"TargetOriginId\":\"site\",\"ViewerProtocolPolicy\":\"redirect-to-https\",
      \"CachePolicyId\":\"658327ea-f89d-4fab-a63d-7e88639e58f6\",\"Compress\":true},
    \"PriceClass\":\"PriceClass_100\"}" --query "Distribution.[Id,DomainName]" --output text)
  echo "$CDN_ID" > "$STATE/cdn_id"; echo "$CDN_DOMAIN" > "$STATE/cdn_domain"
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
    \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},
    \"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/site/*\",
    \"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::$ACCOUNT:distribution/$CDN_ID\"}}}]}"
  echo "cdn: https://$CDN_DOMAIN (takes a few minutes to deploy)"
}

site() {
  cat > web/config.js <<EOF
// Generated by infra/deploy.sh — public values only (the Location key is referer-restricted).
window.OJO_CONFIG = {
  region: "$REGION",
  locationKey: "$(cat $STATE/location_key)",
  apiUrl: "$(cat $STATE/api_url)",
};
EOF
  aws s3 sync web "s3://$BUCKET/site" --delete --cache-control "public, max-age=60" >/dev/null
  if [[ -s $STATE/cdn_id ]]; then
    aws cloudfront create-invalidation --distribution-id "$(cat $STATE/cdn_id)" --paths "/*" >/dev/null
    echo "site: https://$(cat $STATE/cdn_domain)"
  fi
}

case "${1:-all}" in
  backend) backend ;;
  location) location ;;
  cdn) cdn ;;
  site) site ;;
  all) backend; location; cdn; site ;;
  *) echo "usage: $0 [backend|location|cdn|site|all]"; exit 1 ;;
esac
