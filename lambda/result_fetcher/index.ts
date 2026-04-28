import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = (event.pathParameters?.id ?? '').trim();

  if (!requestId) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing request ID in path' }),
    };
  }

  const response = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { requestId: { S: requestId } },
  }));

  if (!response.Item) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ status: 'pending', requestId }),
    };
  }

  const item = response.Item;
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      requestId: item.requestId?.S,
      status: item.status?.S,
      ...(item.result && { result: item.result.S }),
      ...(item.latency_ms && { latency_ms: Number(item.latency_ms.N) }),
      ...(item.completed_at && { completed_at: Number(item.completed_at.N) }),
      ...(item.error_message && { error_message: item.error_message.S }),
    }),
  };
};
