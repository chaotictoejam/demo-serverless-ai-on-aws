#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DemoStack } from '../lib/demo-stack';

const app = new cdk.App();

new DemoStack(app, 'ServerlessAiDemoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Serverless + AI demo: sync vs async Bedrock paths (demo)',
});
