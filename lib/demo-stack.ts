import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';

// Cross-region inference profile for Claude Haiku 4.5 on Bedrock.
// Verify under Bedrock → Model catalog if you get an AccessDeniedException.
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const LAMBDA_TIMEOUT_SYNC = cdk.Duration.seconds(30);
const LAMBDA_TIMEOUT_WORKER = cdk.Duration.seconds(60);
const LAMBDA_TIMEOUT_FAST = cdk.Duration.seconds(10);
const NODE_RUNTIME = lambda.Runtime.NODEJS_20_X;

function nodeFn(
  scope: Construct,
  id: string,
  opts: {
    entry: string;
    timeout: cdk.Duration;
    memorySize: number;
    environment: Record<string, string>;
    description: string;
  },
): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: opts.entry,
    handler: 'handler',
    runtime: NODE_RUNTIME,
    timeout: opts.timeout,
    memorySize: opts.memorySize,
    environment: opts.environment,
    description: opts.description,
    bundling: {
      // AWS SDK v3 ships in the Node.js 20 Lambda runtime; no need to bundle it.
      externalModules: ['@aws-sdk/*'],
      minify: false,
      sourceMap: true,
    },
  });
}

export class DemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── DynamoDB ────────────────────────────────────────────────────────────
    const resultsTable = new dynamodb.Table(this, 'ResultsTable', {
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── SQS ─────────────────────────────────────────────────────────────────
    const dlq = new sqs.Queue(this, 'WorkerDLQ', {
      retentionPeriod: cdk.Duration.days(7),
      queueName: 'serverless-ai-demo-dlq',
    });

    const workQueue = new sqs.Queue(this, 'WorkQueue', {
      visibilityTimeout: cdk.Duration.seconds(60),
      queueName: 'serverless-ai-demo-queue',
      deadLetterQueue: { queue: dlq, maxReceiveCount: 2 },
    });

    // ─── Lambda: sync-handler ─────────────────────────────────────────────────
    const syncHandler = nodeFn(this, 'SyncHandler', {
      entry: path.join(__dirname, '../lambda/sync_handler/index.ts'),
      timeout: LAMBDA_TIMEOUT_SYNC,
      memorySize: 256,
      environment: { BEDROCK_MODEL_ID },
      description: 'Sync path: blocks on Bedrock and returns response directly',
    });

    // Cross-region inference profiles require both the profile ARN and the
    // underlying foundation model ARNs (which may span routed regions).
    syncHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
    }));

    // ─── Lambda: async-ingest ─────────────────────────────────────────────────
    const asyncIngest = nodeFn(this, 'AsyncIngest', {
      entry: path.join(__dirname, '../lambda/async_ingest/index.ts'),
      timeout: LAMBDA_TIMEOUT_FAST,
      memorySize: 128,
      environment: { QUEUE_URL: workQueue.queueUrl },
      description: 'Async path: enqueues work and returns immediately (<200ms)',
    });

    workQueue.grantSendMessages(asyncIngest);

    // ─── Lambda: async-worker ─────────────────────────────────────────────────
    const asyncWorker = nodeFn(this, 'AsyncWorker', {
      entry: path.join(__dirname, '../lambda/async_worker/index.ts'),
      timeout: LAMBDA_TIMEOUT_WORKER,
      memorySize: 256,
      environment: {
        QUEUE_URL: workQueue.queueUrl,
        TABLE_NAME: resultsTable.tableName,
        BEDROCK_MODEL_ID,
      },
      description: 'Async path: processes SQS message, calls Bedrock, writes to DynamoDB',
    });

    asyncWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${BEDROCK_MODEL_ID}`,
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
    }));

    resultsTable.grantWriteData(asyncWorker);

    asyncWorker.addEventSource(new eventsources.SqsEventSource(workQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // ─── Lambda: result-fetcher ───────────────────────────────────────────────
    const resultFetcher = nodeFn(this, 'ResultFetcher', {
      entry: path.join(__dirname, '../lambda/result_fetcher/index.ts'),
      timeout: LAMBDA_TIMEOUT_FAST,
      memorySize: 128,
      environment: { TABLE_NAME: resultsTable.tableName },
      description: 'Returns result for a requestId — always 200, pending or complete',
    });

    resultsTable.grantReadData(resultFetcher);

    // ─── API Gateway ──────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'DemoApi', {
      restApiName: 'serverless-ai-demo',
      description: ' demo: sync vs async AI paths',
      deployOptions: {
        stageName: 'demo',
        throttlingBurstLimit: 50,
        throttlingRateLimit: 20,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // POST /sync
    const syncResource = api.root.addResource('sync');
    syncResource.addMethod('POST', new apigateway.LambdaIntegration(syncHandler), {
      requestModels: { 'application/json': apigateway.Model.EMPTY_MODEL },
    });

    // POST /async
    const asyncResource = api.root.addResource('async');
    asyncResource.addMethod('POST', new apigateway.LambdaIntegration(asyncIngest));

    // GET /result/{id}
    const resultResource = api.root.addResource('result');
    const resultIdResource = resultResource.addResource('{id}');
    resultIdResource.addMethod('GET', new apigateway.LambdaIntegration(resultFetcher));

    // ─── Stack Outputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      value: api.url,
      description: 'API Gateway base URL',
      exportName: 'ServerlessAiDemoApiUrl',
    });

    new cdk.CfnOutput(this, 'SyncEndpoint', {
      value: `${api.url}sync`,
      description: 'POST to this endpoint — blocks until Bedrock responds',
    });

    new cdk.CfnOutput(this, 'AsyncEndpoint', {
      value: `${api.url}async`,
      description: 'POST to this endpoint — returns immediately with a requestId',
    });

    new cdk.CfnOutput(this, 'ResultEndpoint', {
      value: `${api.url}result/{id}`,
      description: 'GET with a requestId to poll for async result',
    });

    new cdk.CfnOutput(this, 'ResultsTableName', {
      value: resultsTable.tableName,
      description: 'DynamoDB table storing async results',
    });

    new cdk.CfnOutput(this, 'WorkQueueUrl', {
      value: workQueue.queueUrl,
      description: 'SQS queue URL for async work items',
    });
  }
}
