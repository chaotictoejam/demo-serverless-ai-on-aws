# Serverless + AI: Building Scalable Systems Without Losing Your Mind

Demo for the AWS User Group meetup talk.  
Deploys two API endpoints that contrast a **naive synchronous** AI path with a
**scalable async** path — both backed by Amazon Bedrock (Claude Haiku).

---

## Architecture

```
SYNC PATH
  POST /sync
  API Gateway → Lambda (sync-handler) → Bedrock → Response
  The caller waits the full duration of the Bedrock call (~1–3 s).

ASYNC PATH
  POST /async
  API Gateway → Lambda (async-ingest) → SQS → Lambda (async-worker) → Bedrock → DynamoDB
  Returns a requestId in <200 ms. Bedrock work happens in the background.

  GET /result/{id}
  API Gateway → Lambda (result-fetcher) → DynamoDB → { pending | complete | error }
```

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | 18 or later |
| AWS CLI | configured with credentials for your account |
| AWS CDK CLI | `npm install -g aws-cdk` |
| CDK bootstrap | `cdk bootstrap` run at least once in your target account/region |
| Bedrock model access | `anthropic.claude-haiku-4-5-20251001` — automatically enabled on first invocation |

> **Note:** The AWS Bedrock Model access page has been retired. Serverless foundation models
> (including Anthropic models) are now automatically enabled across all AWS commercial regions
> when first invoked. No manual activation is required. First-time Anthropic users may need to
> submit use case details before the model can be used.

---

## Install and deploy

```bash
# 1. Install CDK dependencies
npm install

# 2. (First time only) bootstrap CDK in your account
cdk bootstrap

# 3. Deploy the stack — takes ~2 minutes
cdk deploy

# 4. Copy the API Gateway base URL from the Outputs section, e.g.:
#    ServerlessAiDemoStack.ApiBaseUrl = https://abc123.execute-api.us-east-1.amazonaws.com/demo/
export API_URL="https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/demo"
```

---

## Live demo curl commands

### 1 — Sync path (show the wait)

```bash
curl -X POST $API_URL/sync \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain serverless in one sentence"}'
```

Expected: response arrives after ~1–3 seconds.  
Output: `{ "response": "...", "latency_ms": 1842 }`

---

### 2 — Async path (show instant response)

```bash
curl -X POST $API_URL/async \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain serverless in one sentence"}'
```

Expected: response arrives in **under 200 ms**.  
Output: `{ "requestId": "uuid", "status": "processing", "poll_url": "..." }`

---

### 3 — Poll for result (show pending → complete)

```bash
# Replace {requestId} with the value from the async response
curl $API_URL/result/{requestId}
```

Run immediately after the async POST — you will see `{ "status": "pending" }`.  
Run again after ~3 seconds — you will see the complete result:

```json
{
  "requestId": "...",
  "status": "complete",
  "result": "Serverless is a cloud execution model...",
  "latency_ms": 1654,
  "completed_at": 1714300000
}
```

---

## Convenience one-liner (demo loop)

```bash
# Fire async, capture the ID, then poll every second until complete
REQID=$(curl -s -X POST $API_URL/async \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain serverless in one sentence"}' \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).requestId))")

echo "Request ID: $REQID"
for i in {1..10}; do
  sleep 1
  STATUS=$(curl -s $API_URL/result/$REQID)
  echo "$STATUS"
  node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>process.exit(JSON.parse(d).status==='complete'?0:1))" <<< "$STATUS" && break
done
```

---

## Stack outputs

After `cdk deploy` you will see:

| Output | Description |
|---|---|
| `ApiBaseUrl` | API Gateway stage URL |
| `SyncEndpoint` | Full URL for POST /sync |
| `AsyncEndpoint` | Full URL for POST /async |
| `ResultEndpoint` | Full URL pattern for GET /result/{id} |
| `ResultsTableName` | DynamoDB table name |
| `WorkQueueUrl` | SQS queue URL |

---

## Tear down

```bash
cdk destroy
```

All resources (Lambda, API Gateway, SQS, DynamoDB, IAM roles) are deleted.
DynamoDB uses `DESTROY` removal policy so the table is wiped too.

---

## Estimated cost

This demo is effectively **free** for 'demoing' use:

| Service | Pricing note |
|---|---|
| AWS Lambda | 1 M free invocations / month |
| Amazon SQS | 1 M requests / month free |
| Amazon DynamoDB | 25 GB + 200 M requests / month free tier |
| Amazon Bedrock | Pay-per-token; ~$0.001 per demo run with Claude Haiku |
| API Gateway | 1 M calls / month free (first 12 months) |

A full day of live demoing costs pennies.

---

## Troubleshooting

**`ThrottlingException` from Bedrock** — you may have hit the default TPS limit for
the model. Wait a moment and retry; for a high-traffic demo consider requesting a
quota increase in the AWS console.

**`AccessDeniedException` from Bedrock** — the model is enabled automatically on first
invocation, but first-time Anthropic users may need to submit use case details via the
AWS Console before access is granted. Check the Bedrock service page for any pending
approval or account-level IAM/SCP restrictions.

**Async result stays `pending` for >30 s** — check the async-worker Lambda logs in
CloudWatch for errors. The SQS DLQ (`serverless-ai-demo-dlq`) will hold failed
messages after 2 retries.
