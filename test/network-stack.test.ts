import { describe, test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthNetwork, TEST_PROJECT } from './support/harness';

// These tests encode cost/architecture invariants from the stack comments and
// docs/networking-decisions.md as executable checks. If someone "fixes" the VPC
// by adding a NAT gateway, this goes red before it ever costs $64/month.
describe('NetworkStack', () => {
  const { template } = synthNetwork();

  test('provisions zero NAT gateways (use VPC endpoints, not NAT)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('has a free S3 gateway endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  test('adds no paid interface (PrivateLink) endpoints', () => {
    // Interface endpoints are ~$29/mo of idle ENIs — intentionally omitted.
    const interfaceEndpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    if (Object.keys(interfaceEndpoints).length !== 0) {
      throw new Error('unexpected paid Interface VPC endpoint(s) found');
    }
  });

  test('creates a private DNS namespace named <project>.local', () => {
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: `${TEST_PROJECT}.local`,
    });
  });

  test('names the ECS cluster and enables Fargate capacity providers', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: `${TEST_PROJECT}-cluster`,
    });
    template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: Match.arrayWith(['FARGATE', 'FARGATE_SPOT']),
    });
  });
});
