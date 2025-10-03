import { useEffect } from "react";
import { useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  List,
  Link,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  
  // Just return basic info, the wholesale page setup is handled in app.wholesalepage.jsx
  return {
    appInstalled: true,
    timestamp: new Date().toISOString()
  };
};

// No action needed here - form submissions are handled by apps.proxy.jsx

export default function Index() {
  const fetcher = useFetcher();
  const navigate = useNavigate();

  // Trigger the wholesale page setup when this component mounts
  useEffect(() => {
    // Navigate to wholesale page to trigger its loader (page creation)
    // This ensures the page gets created when the app is installed/accessed
    fetcher.load("/app/wholesalepage");
    fetcher.load("/app/metafielddefinition");
  }, []);

  return (
    <Page>
      <TitleBar title="Wholesale App Dashboard" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Wholesale Registration App 🎉
                  </Text>
                  <Text variant="bodyMd" as="p">
                    Your wholesale registration app has been successfully installed! 
                    The wholesale registration page is being set up automatically.
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    App Features:
                  </Text>
                  <List>
                    <List.Item>
                      Automatic wholesale registration page creation
                    </List.Item>
                    <List.Item>
                      Customer login protection for the registration form
                    </List.Item>
                    <List.Item>
                      B2B company and customer management integration
                    </List.Item>
                    <List.Item>
                      Form validation and error handling
                    </List.Item>
                    <List.Item>
                      Automatic navigation menu integration
                    </List.Item>
                  </List>
                </BlockStack>
                <InlineStack gap="300">
                  <Button
                    onClick={() => navigate("/app/wholesalepage")}
                    variant="primary"
                  >
                    View Wholesale Page Management
                  </Button>
                </InlineStack>
                <Text variant="bodyMd" as="p">
                  Visit your storefront to see the wholesale registration form in action!
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}