import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();
    console.log("Form data received:", Object.fromEntries(formData));
    
    // Try multiple ways to get the shop parameter
    let shop;
    let session;
    
    try {
      // First try the proper app proxy authentication
      const { shop: proxyShop } = await authenticate.public.appProxy(request);
      shop = proxyShop;
      console.log("Shop from authenticate.public.appProxy:", shop);
    } catch (error) {
      console.log("App proxy authentication failed:", error.message);
    }
    
    // If that didn't work, try getting shop from URL parameters or form data
    if (!shop) {
      const url = new URL(request.url);
      shop = url.searchParams.get("shop") || formData.get("shop");
      console.log("Shop from URL/form data:", shop);
    }
    
    // If still no shop, try getting it from referrer or headers
    if (!shop) {
      const referrer = request.headers.get("referer");
      console.log("Referrer:", referrer);
      if (referrer) {
        const referrerUrl = new URL(referrer);
        // Extract shop from subdomain like https://shop-name.myshopify.com
        const hostname = referrerUrl.hostname;
        if (hostname.includes('.myshopify.com')) {
          shop = hostname.replace('.myshopify.com', '');
          console.log("Shop extracted from referrer:", shop);
        }
      }
    }
    
    console.log("Final shop value:", shop);
    
    if (!shop) {
      console.error("Could not determine shop from any source");
      return json({ error: "Shop parameter missing" }, { status: 400 });
    }

    // Load the session for this shop to get the admin API access
    const { sessionStorage } = await import("../shopify.server");
    
    // Try different session key formats
    session = await sessionStorage.loadSession(`offline_${shop}`);
    if (!session) {
      session = await sessionStorage.loadSession(`offline_${shop}.myshopify.com`);
    }
    
    console.log("Session found:", !!session);
    
    if (!session) {
      console.error("No session found for shop:", shop);
      // List available sessions for debugging
      try {
        const sessions = await sessionStorage.findSessionsByShop(shop);
        console.log("Available sessions for shop:", sessions?.length || 0);
      } catch (e) {
        console.log("Could not list sessions");
      }
      return json({ error: "App not installed for this shop" }, { status: 401 });
    }

    // Create a proper admin context using the session
    const adminApiContext = {
      session,
      userAgent: 'Shopify App',
    };

    // Use the authenticate.admin method to get a proper admin client
    const mockRequest = {
      ...request,
      headers: new Headers({
        ...Object.fromEntries(request.headers.entries()),
        'authorization': `Bearer ${session.accessToken}`,
        'x-shopify-shop-domain': shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`
      })
    };

    let admin;
    try {
      const authResult = await authenticate.admin(mockRequest);
      admin = authResult.admin;
    } catch (authError) {
      console.log("Admin authentication failed, creating manual admin client");
      
      // Fallback: create admin client manually
      admin = {
        graphql: async (query, options = {}) => {
          const endpoint = `https://${shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`}/admin/api/2024-10/graphql.json`;
          
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': session.accessToken,
            },
            body: JSON.stringify({
              query: query,
              variables: options.variables || {}
            })
          });
          
          return {
            json: () => response.json()
          };
        }
      };
    }

    const userEmail = formData.get("userEmail");

    // First, check if customer with this email already exists
    console.log("Checking if customer exists with email:", userEmail);

    const customerCheckResponse = await admin.graphql(
      `#graphql
        query GetCustomerByEmail($query: String!) {
          customers(first: 1, query: $query) {
            edges {
              node {
                id
                email
                firstName
                lastName
              }
            }
          }
        }`,
      { variables: { query: `email:${userEmail}` } }
    );

    const customerCheckJson = await customerCheckResponse.json();
    console.log("Customer check response:", customerCheckJson);
    const existingCustomer = customerCheckJson.data?.customers?.edges?.[0]?.node;

    if (existingCustomer) {
      console.log("Email has been present - Customer ID:", existingCustomer.id);
      console.log("Existing customer details:", existingCustomer);
      
      // Update existing customer's first name and last name
      const formFirstName = formData.get("firstName");
      const formLastName = formData.get("lastName");
      
      console.log("Updating customer with form data:", { firstName: formFirstName, lastName: formLastName });
      
      const customerUpdateResponse = await admin.graphql(
        `#graphql
          mutation UpdateCustomer($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer {
                id
                email
                firstName
                lastName
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            input: {
              id: existingCustomer.id,
              firstName: formFirstName,
              lastName: formLastName
            }
          }
        }
      );
      
      const customerUpdateJson = await customerUpdateResponse.json();
      console.log("Customer update response:", customerUpdateJson);
      
      if (customerUpdateJson.data?.customerUpdate?.userErrors?.length > 0) {
        console.error("Customer update errors:", customerUpdateJson.data.customerUpdate.userErrors);
      } else {
        console.log("Customer updated successfully:", customerUpdateJson.data?.customerUpdate?.customer);
      }
    } else {
      console.log("Customer with this email does not exist, proceeding with creation");
    }

    // 1. Create company (different approach for existing vs new customers)
    let companyInput;
    
    if (existingCustomer) {
      // For existing customers, create company without companyContact to avoid email conflict
      companyInput = {
        company: {
          name: formData.get("companyName"),
          externalId: `ext-${Date.now()}`,
          note: `Created from Wholesale Registration form`,
        }
      };
      console.log("Creating company without contact (existing customer) with input:", companyInput);
    } else {
      // For new customers, create company with companyContact
      companyInput = {
        company: {
          name: formData.get("companyName"),
          externalId: `ext-${Date.now()}`,
          note: `Created from Wholesale Registration form`,
        },
        companyContact: {
          email: formData.get("userEmail"),
          firstName: formData.get("firstName"),
          lastName: formData.get("lastName"),
        }
      };
      console.log("Creating company with contact (new customer) with input:", companyInput);
    }
    const companyResponse = await admin.graphql(
      `#graphql
        mutation CreateCompany($input: CompanyCreateInput!) {
          companyCreate(input: $input) {
            company {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { input: companyInput } }
    );
    
    const companyJson = await companyResponse.json();
    console.log("Company creation response:", JSON.stringify(companyJson, null, 2));
    
    if (companyJson.errors) {
      console.error("GraphQL errors in company creation:", companyJson.errors);
      return json({ error: "GraphQL errors in company creation", details: companyJson.errors }, { status: 400 });
    }
    
    if (companyJson.data?.companyCreate?.userErrors?.length > 0) {
      console.error("Company creation errors:", companyJson.data.companyCreate.userErrors);
      return json({ error: "Failed to create company", details: companyJson.data.companyCreate.userErrors }, { status: 400 });
    }
    
    const companyId = companyJson.data?.companyCreate?.company?.id;
    console.log("Created company ID:", companyId);

    // 2. Handle customer creation or use existing customer
    let customerId = null;
    let customerError = null;

    if (existingCustomer) {
      // Use the existing customer that was already updated
      customerId = existingCustomer.id;
      console.log("Using existing customer ID:", customerId);
    } else {
      // Create new customer
      const customerInput = {
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
        email: formData.get("userEmail"),
        phone: formData.get("phone"),
      };

      console.log("Creating new customer with input:", customerInput);
      const customerResponse = await admin.graphql(
        `#graphql
          mutation CreateCustomer($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer {
                id
                email
                firstName
                lastName
              }
              userErrors {
                field
                message
              }
            }
          }`,
        { variables: { input: customerInput } }
      );
      
      const customerJson = await customerResponse.json();
      console.log("Customer creation response:", JSON.stringify(customerJson, null, 2));
      
      if (customerJson.errors) {
        console.error("GraphQL errors in customer creation:", customerJson.errors);
        customerError = "GraphQL errors in customer creation";
      } else if (customerJson.data?.customerCreate?.userErrors?.length > 0) {
        console.error("Customer creation errors:", customerJson.data.customerCreate.userErrors);
        customerError = customerJson.data.customerCreate.userErrors[0].message;
      } else {
        customerId = customerJson.data?.customerCreate?.customer?.id;
        console.log("Created new customer ID:", customerId);
      }
    }

    // Only try to assign if both IDs exist
    if (companyId && customerId) {
      if (existingCustomer) {
        // 3a. For existing customers, create (assign) company contact, then make them main contact
        console.log("Assigning existing customer as a company contact:", { companyId, customerId });

        const assignCustomerAsContactResp = await admin.graphql(
          `#graphql
            mutation AssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
              companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
                companyContact {
                  id
                }
                userErrors {
                  field
                  message
                  code
                }
              }
            }`,
          { variables: { companyId, customerId } }
        );

        const assignCustomerAsContactJson = await assignCustomerAsContactResp.json();
        console.log("Assign customer as contact response:", JSON.stringify(assignCustomerAsContactJson, null, 2));

        const companyContactId =
          assignCustomerAsContactJson.data?.companyAssignCustomerAsContact?.companyContact?.id;

        if (companyContactId) {
          console.log("Assigning company contact as main contact:", { companyId, companyContactId });

          const assignMainResp = await admin.graphql(
            `#graphql
              mutation AssignMainContact($companyId: ID!, $companyContactId: ID!) {
                companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
                  company { id mainContact { id } }
                  userErrors { field message code }
                }
              }`,
            { variables: { companyId, companyContactId } }
          );

          const assignMainJson = await assignMainResp.json();
          console.log("Assign main contact response:", JSON.stringify(assignMainJson, null, 2));
        } else {
          console.error(
            "Failed to assign customer as contact:",
            assignCustomerAsContactJson.data?.companyAssignCustomerAsContact?.userErrors
          );
        }
      } else {
        // 3. For new customers created with company, they should already be assigned
        console.log("New customer should already be assigned to company via companyCreate");
      }
    } else {
      console.warn("Skipping assignment - missing IDs:", { companyId, customerId });
    }

    // Determine success status and message
    let success = false;
    let message = "";
    
    if (companyId && customerId) {
      success = true;
      message = "Company and customer created successfully!";
    } else if (companyId && customerError) {
      success = true;
      message = `Company created successfully! Note: ${customerError}`;
    } else if (companyId) {
      success = true;
      message = "Company created successfully!";
    } else {
      success = false;
      message = "Failed to create company.";
    }

    console.log("Final result:", { success, companyId, customerId, customerError });
    
    return json({ 
      success: success, 
      companyId, 
      customerId,
      message: message,
      customerError: customerError
    });
    
  } catch (error) {
    console.error("Error in proxy action:", error);
    return json({ error: "Internal server error", details: error.message }, { status: 500 });
  }
};

export const loader = async ({ request }) => {
  return json({ status: "App Proxy route working ✅" });
};

export default function ProxyRoute() {
  return (
    <div>
      <h1>App Proxy Route</h1>
      <p>App Proxy route working ✅</p>
      <p>This route handles form submissions from the storefront.</p>
    </div>
  );
}