import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import { Construct } from 'constructs';

export interface CostStackProps extends cdk.StackProps {
  projectName: string;
  alertEmail: string;
  // Default $50/mo — override with -c monthlyBudgetUsd=100 if spend grows.
  monthlyBudgetUsd: number;
}

// CE (Cost Explorer) resources are global but CloudFormation requires us-east-1.
// Always deploy this stack with env.region = 'us-east-1'.
export class CostStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CostStackProps) {
    super(scope, id, props);

    const { projectName, alertEmail, monthlyBudgetUsd } = props;

    // Monthly budget — two notifications:
    //   80% actual  → heads-up before you overshoot
    //   100% forecasted → early warning based on AWS spend projection
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${projectName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        },
      ],
    });

    // Cost Anomaly Detection — scoped to this project's tag so only resources
    // tagged Project=<projectName> contribute to anomaly scoring.
    const monitor = new ce.CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: `${projectName}-monitor`,
      monitorType: 'CUSTOM',
      monitorSpecification: JSON.stringify({
        Tags: {
          Key: 'Project',
          Values: [projectName],
          MatchOptions: ['EQUALS'],
        },
      }),
    });

    // Alert once per day when cumulative anomaly impact exceeds $5.
    new ce.CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: `${projectName}-anomaly-alerts`,
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ address: alertEmail, type: 'EMAIL' }],
      frequency: 'DAILY',
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          Values: ['5'],
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
        },
      }),
    });
  }
}
