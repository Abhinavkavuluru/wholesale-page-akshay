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
    const phoneNumber = formData.get("phone");

    // Debug: Log all form data including phone
    console.log("=== FORM DATA DEBUG ===");
    console.log("Phone number from form:", phoneNumber);
    console.log("Phone number type:", typeof phoneNumber);
    console.log("Phone number length:", phoneNumber ? phoneNumber.length : 'null/undefined');
    console.log("Phone number trimmed:", phoneNumber ? phoneNumber.trim() : 'null/undefined');
    console.log("======================");

    // First, check if customer with this email already exists
    console.log("Checking if customer exists with email:", userEmail);

    const customerCheckResponse = await admin.graphql(
      `#graphql
        query GetCustomerByEmail($query: String!) {
          customers(first: 5, query: $query) {
            edges {
              node {
                id
                email
                firstName
                lastName
                phone
                tags
              }
            }
          }
        }`,
      { variables: { query: `email:"${userEmail.toLowerCase().trim()}"` } }
    );

    const customerCheckJson = await customerCheckResponse.json();
    console.log("Customer check response:", customerCheckJson);
    const existingCustomer = customerCheckJson.data?.customers?.edges?.[0]?.node;

    if (existingCustomer) {
      console.log("Email has been present - Customer ID:", existingCustomer.id);
      console.log("Existing customer details:", existingCustomer);
      
      // Update existing customer's first name, last name, and phone number
      const formFirstName = formData.get("firstName");
      const formLastName = formData.get("lastName");
      const formPhone = formData.get("phone");
      
      console.log("Updating customer with form data:", { firstName: formFirstName, lastName: formLastName, phone: formPhone });
      
      // Prepare customer input - only include phone if it has a value
      const customerInput = {
        id: existingCustomer.id,
        firstName: formFirstName,
        lastName: formLastName
      };
      
      // Preserve existing tags and ensure 'wholesale' is included
      const existingTags = existingCustomer.tags || [];
      const wholesaleTag = "wholesale";
      if (!existingTags.includes(wholesaleTag)) {
        existingTags.push(wholesaleTag);
      }
      customerInput.tags = existingTags;
      
      // Only add phone if it's not empty
      if (formPhone && formPhone.trim()) {
        customerInput.phone = formPhone.trim();
        console.log("Adding phone to customer update:", formPhone.trim());
      } else {
        console.log("Phone is empty, not including in update");
      }
      
      console.log("Customer tags being set:", customerInput.tags);
      
      const customerUpdateResponse = await admin.graphql(
        `#graphql
          mutation UpdateCustomer($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer {
                id
                email
                firstName
                lastName
                phone
                tags
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            input: customerInput
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

    // 1. Check if company with this email already exists in metafield
    const companyEmail = formData.get("companyEmail");
    console.log("Checking if company exists with email:", companyEmail);

    let existingCompany = null;
    if (companyEmail && companyEmail.trim()) {
      const companyCheckResponse = await admin.graphql(
        `#graphql
          query GetCompaniesByEmailMetafield {
            companies(first: 50) {
              edges {
                node {
                  id
                  name
                  metafields(first: 10) {
                    edges {
                      node {
                        id
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                }
              }
            }
          }`
      );

      const companyCheckJson = await companyCheckResponse.json();
      console.log("Company check response:", companyCheckJson);
      
      // Find company with matching email metafield
      const companies = companyCheckJson.data?.companies?.edges || [];
      for (const companyEdge of companies) {
        const company = companyEdge.node;
        const emailMetafield = company.metafields?.edges?.find(
          metafieldEdge => metafieldEdge.node.namespace === "custom" &&
                          metafieldEdge.node.key === "companyEmail" && 
                          metafieldEdge.node.value.toLowerCase() === companyEmail.toLowerCase().trim()
        );
        
        if (emailMetafield) {
          existingCompany = company;
          console.log("Found existing company with email metafield:", existingCompany);
          console.log("Matching metafield:", emailMetafield);
          break;
        }
      }
      
      console.log("Total companies checked:", companies.length);
      console.log("Looking for company email:", companyEmail.toLowerCase().trim());
      
      if (!existingCompany) {
        console.log("No existing company found with this email, proceeding with creation");
      }
    } else {
      console.log("No company email provided, proceeding with creation");
    }

    // 2. Create or use existing company
    let companyId;
    
    if (existingCompany) {
      // Use existing company
      companyId = existingCompany.id;
      console.log("Using existing company ID:", companyId);
      console.log("Existing company details:", existingCompany);
    } else {
      // Create new company (different approach for existing vs new customers)
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
      
      companyId = companyJson.data?.companyCreate?.company?.id;
      console.log("Created new company ID:", companyId);
    }

    // Set company email metafield only for newly created companies
    if (companyId && !existingCompany) {
      const companyEmail = formData.get("companyEmail");
      if (companyEmail && companyEmail.trim()) {
        console.log("Setting company email metafield for new company:", companyEmail.trim());
        
        try {
          const metafieldResponse = await admin.graphql(
            `#graphql
              mutation SetCompanyEmailMetafield($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                  metafields {
                    id
                    key
                    namespace
                    value
                    type
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`,
            {
              variables: {
                metafields: [
                  {
                    ownerId: companyId,
                    namespace: "custom",
                    key: "companyEmail",
                    value: companyEmail.trim(),
                    type: "single_line_text_field",
                  },
                ],
              },
            }
          );
          
          const metafieldJson = await metafieldResponse.json();
          console.log("Company email metafield response:", JSON.stringify(metafieldJson, null, 2));
          
          if (metafieldJson.data?.metafieldsSet?.userErrors?.length > 0) {
            console.error("Company email metafield errors:", metafieldJson.data.metafieldsSet.userErrors);
          } else {
            console.log("Company email metafield set successfully:", metafieldJson.data?.metafieldsSet?.metafields?.[0]);
          }
        } catch (metafieldError) {
          console.error("Error setting company email metafield:", metafieldError);
        }
      } else {
        console.log("No company email provided, skipping metafield creation");
      }
    } else if (existingCompany) {
      console.log("Using existing company, skipping metafield creation (already exists)");
    }

    // 1.5. Add shipping address to the company if companyId exists
    if (companyId) {
      const address1 = formData.get("address1");
      const address2 = formData.get("address2");
      const city = formData.get("city");
      const state = formData.get("state");
      const country = formData.get("country");
      const zipCode = formData.get("zip_code");
      
      // Only create address if at least address1 is provided
      if (address1 && address1.trim()) {
        console.log("Adding shipping address to company:", {
          address1,
          address2,
          city,
          state,
          country,
          zipCode
        });
        
        const addressInput = {
          companyId: companyId,
          address: {
            address1: address1.trim(),
            city: city?.trim() || "",
            countryCode: (country || "IN").trim(),
            zoneCode: (state || "").trim(),
            zip: zipCode?.trim() || ""
          }
        };
        
        // Add address2 if provided
        if (address2 && address2.trim()) {
          addressInput.address.address2 = address2.trim();
        }
        
        try {
          // First, get the company's default location
          const companyLocationResponse = await admin.graphql(
            `#graphql
              query GetCompanyLocations($companyId: ID!) {
                company(id: $companyId) {
                  locations(first: 1) {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                }
              }`,
            { variables: { companyId: companyId } }
          );
          
          const companyLocationJson = await companyLocationResponse.json();
          console.log("Company location response:", JSON.stringify(companyLocationJson, null, 2));
          
          const locationId = companyLocationJson.data?.company?.locations?.edges?.[0]?.node?.id;
          
          if (locationId) {
            console.log("Found company location ID:", locationId);
            
            // Update location name if provided in form
            const locationNameFromForm = (formData.get("location") || "").trim();
            if (locationNameFromForm) {
              console.log("Updating location name to:", locationNameFromForm);
              
              const updateLocationResponse = await admin.graphql(
                `#graphql
                  mutation UpdateCompanyLocationName($companyLocationId: ID!, $input: CompanyLocationUpdateInput!) {
                    companyLocationUpdate(companyLocationId: $companyLocationId, input: $input) {
                      companyLocation { 
                        id 
                        name 
                      }
                      userErrors { 
                        field 
                        message 
                      }
                    }
                  }`,
                {
                  variables: {
                    companyLocationId: locationId,
                    input: { name: locationNameFromForm }
                  }
                }
              );
              
              const updateLocationJson = await updateLocationResponse.json();
              console.log("Location name update response:", JSON.stringify(updateLocationJson, null, 2));
              
              if (updateLocationJson?.data?.companyLocationUpdate?.userErrors?.length > 0) {
                console.error("Location name update errors:", updateLocationJson.data.companyLocationUpdate.userErrors);
              } else {
                console.log("Location renamed successfully to:", updateLocationJson?.data?.companyLocationUpdate?.companyLocation?.name);
              }
            }
            
            // Now assign the address to the company location
            const addressResponse = await admin.graphql(
              `#graphql
                mutation CompanyLocationAssignAddress($locationId: ID!, $address: CompanyAddressInput!, $addressTypes: [CompanyAddressType!]!) {
                  companyLocationAssignAddress(
                    locationId: $locationId
                    address: $address
                    addressTypes: $addressTypes
                  ) {
                    addresses {
                      id
                      address1
                      address2
                      city
                      province
                      country
                      zip
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
              { 
                variables: { 
                  locationId: locationId,
                  address: addressInput.address,
                  addressTypes: ["SHIPPING"]
                } 
              }
            );
            
            const addressJson = await addressResponse.json();
            console.log("Company address assignment response:", JSON.stringify(addressJson, null, 2));
            
            if (addressJson.data?.companyLocationAssignAddress?.userErrors?.length > 0) {
              console.error("Company address assignment errors:", addressJson.data.companyLocationAssignAddress.userErrors);
            } else {
              console.log("Company shipping address assigned successfully:", addressJson.data?.companyLocationAssignAddress?.addresses);
            }

            // Set TAX ID if provided in the form
            const taxId = formData.get("taxId");
            if (taxId && taxId.trim()) {
              console.log("Setting TAX ID for company location:", { locationId, taxId: taxId.trim() });

              try {
                const taxUpdateResponse = await admin.graphql(
                  `#graphql
                    mutation SetCompanyLocationTaxId(
                      $companyLocationId: ID!,
                      $taxRegistrationId: String
                    ) {
                      companyLocationTaxSettingsUpdate(
                        companyLocationId: $companyLocationId
                        taxRegistrationId: $taxRegistrationId
                      ) {
                        companyLocation {
                          id
                          taxSettings {
                            taxRegistrationId
                            taxExempt
                          }
                        }
                        userErrors { field message code }
                      }
                    }`,
                  {
                    variables: {
                      companyLocationId: locationId,
                      taxRegistrationId: taxId.trim(),
                    },
                  }
                );

                const taxUpdateJson = await taxUpdateResponse.json();
                console.log("TAX ID update response:", JSON.stringify(taxUpdateJson, null, 2));

                if (taxUpdateJson.errors) {
                  // Check if the mutation doesn't exist (not a Plus store or API limitation)
                  const mutationNotFound = taxUpdateJson.errors.some(error => 
                    error.message.includes("companyLocationTaxSettingsUpdate") && 
                    error.message.includes("doesn't exist on type 'Mutation'")
                  );
                  
                  if (mutationNotFound) {
                    console.warn("TAX ID setting not available: Store may not be Shopify Plus or B2B feature not enabled. Tax ID collected but not set in Shopify.");
                    console.log("Tax ID from form (stored for reference):", taxId.trim());
                  } else {
                    console.error("TAX ID GraphQL errors:", taxUpdateJson.errors);
                  }
                } else {
                  const errs = taxUpdateJson.data?.companyLocationTaxSettingsUpdate?.userErrors;
                  if (errs?.length) {
                    console.error("TAX ID update errors:", errs);
                  } else {
                    const updated = taxUpdateJson.data?.companyLocationTaxSettingsUpdate?.companyLocation;
                    console.log("TAX ID set successfully:", updated?.taxSettings?.taxRegistrationId || "(updated)");
                  }
                }
              } catch (taxError) {
                console.error("Error setting TAX ID:", taxError);
                console.log("Tax ID from form (collected but not set):", taxId.trim());
              }
            } else {
              console.log("No TAX ID provided, skipping tax settings update");
            }
          } else {
            console.error("No company location found for company:", companyId);
          }
        } catch (addressError) {
          console.error("Error assigning company address:", addressError);
        }
      } else {
        console.log("No address1 provided, skipping address creation");
      }
    }

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
        tags: ["wholesale"],
      };
      
      // Only add phone if it has a value
      const newCustomerPhone = formData.get("phone");
      if (newCustomerPhone && newCustomerPhone.trim()) {
        customerInput.phone = newCustomerPhone.trim();
        console.log("Adding phone to new customer:", newCustomerPhone.trim());
      } else {
        console.log("Phone is empty, not including in new customer creation");
      }

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
                phone
                tags
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
        const errorMessage = customerJson.data.customerCreate.userErrors[0].message;
        
        // If email already exists, try to find and update the existing customer
        if (errorMessage.includes("Email has already been taken")) {
          console.log("Email conflict detected, searching for existing customer with broader query");
          
          // Try multiple search strategies to find the existing customer
          console.log("Trying multiple search strategies for email:", userEmail);
          
          // Strategy 1: Search by exact email
          const fallbackSearchResponse1 = await admin.graphql(
            `#graphql
              query SearchCustomerByEmail($email: String!) {
                customers(first: 10, query: $email) {
                  edges {
                    node {
                      id
                      email
                      firstName
                      lastName
                      phone
                      tags
                    }
                  }
                }
              }`,
            { variables: { email: userEmail.trim() } }
          );
          
          let fallbackSearchJson = await fallbackSearchResponse1.json();
          console.log("Strategy 1 - Direct email search:", fallbackSearchJson);
          
          // Strategy 2: Search with email: prefix
          if (!fallbackSearchJson.data?.customers?.edges?.length) {
            console.log("Strategy 1 failed, trying email: prefix search");
            const fallbackSearchResponse2 = await admin.graphql(
              `#graphql
                query SearchCustomerByEmailPrefix($query: String!) {
                  customers(first: 10, query: $query) {
                    edges {
                      node {
                        id
                        email
                        firstName
                        lastName
                        phone
                        tags
                      }
                    }
                  }
                }`,
              { variables: { query: `email:${userEmail.trim()}` } }
            );
            
            fallbackSearchJson = await fallbackSearchResponse2.json();
            console.log("Strategy 2 - Email prefix search:", fallbackSearchJson);
          }
          
          // Strategy 3: Get all customers and filter (last resort)
          if (!fallbackSearchJson.data?.customers?.edges?.length) {
            console.log("Strategy 2 failed, trying to get all recent customers");
            const fallbackSearchResponse3 = await admin.graphql(
              `#graphql
                query GetAllRecentCustomers {
                  customers(first: 50, sortKey: CREATED_AT, reverse: true) {
                    edges {
                      node {
                        id
                        email
                        firstName
                        lastName
                        phone
                        tags
                        createdAt
                      }
                    }
                  }
                }`
            );
            
            const allCustomersJson = await fallbackSearchResponse3.json();
            console.log("Strategy 3 - All recent customers count:", allCustomersJson.data?.customers?.edges?.length || 0);
            
            // Filter for our email
            const matchingCustomers = allCustomersJson.data?.customers?.edges?.filter(
              edge => edge.node.email.toLowerCase() === userEmail.toLowerCase().trim()
            ) || [];
            
            console.log("Found matching customers:", matchingCustomers.length);
            
            if (matchingCustomers.length > 0) {
              fallbackSearchJson = {
                data: {
                  customers: {
                    edges: matchingCustomers
                  }
                }
              };
              console.log("Strategy 3 - Found customer via all customers filter:", matchingCustomers[0].node);
            }
          }
          
          console.log("Final fallback search response:", fallbackSearchJson);
          
          // Look for exact email match in results
          const foundCustomer = fallbackSearchJson.data?.customers?.edges?.find(
            edge => edge.node.email.toLowerCase() === userEmail.toLowerCase().trim()
          )?.node;
          
          if (foundCustomer) {
            console.log("Found existing customer via fallback search:", foundCustomer);
            
            // Update the existing customer with new data including phone
            const formFirstName = formData.get("firstName");
            const formLastName = formData.get("lastName");
            const formPhone = formData.get("phone");
            
            console.log("Updating found customer with form data:", { firstName: formFirstName, lastName: formLastName, phone: formPhone });
            
            // Prepare fallback customer input - only include phone if it has a value
            const fallbackCustomerInput = {
              id: foundCustomer.id,
              firstName: formFirstName,
              lastName: formLastName
            };
            
            // Preserve existing tags and ensure 'wholesale' is included
            const existingTags = foundCustomer.tags || [];
            const wholesaleTag = "wholesale";
            if (!existingTags.includes(wholesaleTag)) {
              existingTags.push(wholesaleTag);
            }
            fallbackCustomerInput.tags = existingTags;
            
            // Only add phone if it's not empty
            if (formPhone && formPhone.trim()) {
              fallbackCustomerInput.phone = formPhone.trim();
              console.log("Adding phone to fallback customer update:", formPhone.trim());
            } else {
              console.log("Phone is empty, not including in fallback update");
            }
            
            console.log("Fallback customer tags being set:", fallbackCustomerInput.tags);
            
            const customerUpdateResponse = await admin.graphql(
              `#graphql
                mutation UpdateCustomer($input: CustomerInput!) {
                  customerUpdate(input: $input) {
                    customer {
                      id
                      email
                      firstName
                      lastName
                      phone
                      tags
                    }
                    userErrors {
                      field
                      message
                    }
                  }
                }`,
              {
                variables: {
                  input: fallbackCustomerInput
                }
              }
            );
            
            const customerUpdateJson = await customerUpdateResponse.json();
            console.log("Fallback customer update response:", customerUpdateJson);
            
            if (customerUpdateJson.data?.customerUpdate?.userErrors?.length > 0) {
              console.error("Fallback customer update errors:", customerUpdateJson.data.customerUpdate.userErrors);
              customerError = customerUpdateJson.data.customerUpdate.userErrors[0].message;
            } else {
              customerId = foundCustomer.id;
              console.log("Successfully updated existing customer via fallback:", customerId);
              customerError = null; // Clear the error since we successfully updated
            }
          } else {
            customerError = errorMessage;
          }
        } else {
          customerError = errorMessage;
        }
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
          
          // Company ordering approval happens automatically when roles are successfully assigned
          
          // After assigning main contact, assign location permissions for existing customer
          if (companyContactId) {
            console.log("Assigning location permissions for existing customer after main contact assignment:", companyId);
            
            try {
              // Get company location with existing role assignments to find a valid role ID
              const locationWithRolesResp = await admin.graphql(
                `#graphql
                  query GetLocationRoles($companyId: ID!) {
                    company(id: $companyId) {
                      locations(first: 1) {
                        edges {
                          node {
                            id
                            name
                            roleAssignments(first: 5) {
                              edges {
                                node {
                                  role {
                                    id
                                    name
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }`,
                { variables: { companyId } }
              );

              const locationData = await locationWithRolesResp.json();
              console.log("Company location with roles response:", JSON.stringify(locationData, null, 2));
              
              const location = locationData.data?.company?.locations?.edges?.[0]?.node;
              
              if (location) {
                console.log("Found company location:", { id: location.id, name: location.name });
                
                // Check if there are existing role assignments to use as a reference
                const existingRoles = location.roleAssignments?.edges || [];
                console.log("Existing role assignments:", existingRoles);
                
                // First fetch available company roles to get valid role IDs
                console.log("Fetching company roles to assign buyer permissions...");
                
                const getRolesResp = await admin.graphql(
                  `#graphql
                    query GetCompanyRoles($companyId: ID!) {
                      company(id: $companyId) {
                        defaultRole { 
                          id 
                          name 
                        }
                        contactRoles(first: 25) {
                          nodes { 
                            id 
                            name 
                          }
                        }
                      }
                    }`,
                  { variables: { companyId } }
                );
                
                const rolesData = await getRolesResp.json();
                console.log("Company roles response:", JSON.stringify(rolesData, null, 2));
                
                // Choose the best role ID for ordering permissions
                let roleIdToAssign;
                let roleName;
                
                if (rolesData.data?.company?.defaultRole) {
                  // Use default role if available (usually "Buyer")
                  roleIdToAssign = rolesData.data.company.defaultRole.id;
                  roleName = rolesData.data.company.defaultRole.name;
                  console.log("Using default role:", { id: roleIdToAssign, name: roleName });
                } else if (rolesData.data?.company?.contactRoles?.nodes?.length > 0) {
                  // Find a buyer role, then admin role as fallback
                  const roles = rolesData.data.company.contactRoles.nodes;
                  
                  let buyerRole = roles.find(role => role.name.toLowerCase().includes('buyer'));
                  let adminRole = roles.find(role => role.name.toLowerCase().includes('admin'));
                  
                  if (buyerRole) {
                    roleIdToAssign = buyerRole.id;
                    roleName = buyerRole.name;
                    console.log("Using buyer role:", { id: roleIdToAssign, name: roleName });
                  } else if (adminRole) {
                    roleIdToAssign = adminRole.id;
                    roleName = adminRole.name;
                    console.log("Using admin role as fallback:", { id: roleIdToAssign, name: roleName });
                  } else {
                    // Use first available role
                    roleIdToAssign = roles[0].id;
                    roleName = roles[0].name;
                    console.log("Using first available role:", { id: roleIdToAssign, name: roleName });
                  }
                }
                
                if (roleIdToAssign) {
                  console.log("Assigning role to company contact:", { 
                    companyContactId, 
                    locationId: location.id,
                    roleId: roleIdToAssign,
                    roleName
                  });
                  
                  // Now assign the role using proper role ID
                  const assignRoleResp = await admin.graphql(
                    `#graphql
                      mutation AssignRole($contactId: ID!, $roleId: ID!, $locationId: ID!) {
                        companyContactAssignRoles(
                          companyContactId: $contactId,
                          rolesToAssign: [{
                            companyContactRoleId: $roleId,
                            companyLocationId: $locationId
                          }]
                        ) {
                          roleAssignments {
                            id
                            role { 
                              id 
                              name 
                            }
                            companyLocation { 
                              id 
                              name 
                            }
                          }
                          userErrors { 
                            field 
                            message 
                            code
                          }
                        }
                      }`,
                    { 
                      variables: { 
                        contactId: companyContactId,
                        roleId: roleIdToAssign,
                        locationId: location.id
                      }
                    }
                  );
                  
                  const roleResult = await assignRoleResp.json();
                  console.log("Role assignment result:", JSON.stringify(roleResult, null, 2));
                  
                  if (roleResult.data?.companyContactAssignRoles?.userErrors?.length === 0 && 
                      roleResult.data?.companyContactAssignRoles?.roleAssignments?.length > 0) {
                    console.log(`🎉 Successfully assigned ${roleName} role! Company should now be approved for ordering.`);
                  } else {
                    console.error("Role assignment failed:", roleResult.data?.companyContactAssignRoles?.userErrors);
                  }
                } else {
                  console.error("No valid role found to assign");
                }
              } else {
                console.error("No company location found for role assignment");
              }
            } catch (permissionError) {
              console.error("Error assigning location permissions:", permissionError);
            }
          }
        } else {
          console.error(
            "Failed to assign customer as contact:",
            assignCustomerAsContactJson.data?.companyAssignCustomerAsContact?.userErrors
          );
        }
      } else if (existingCompany) {
        // 3b. For new customers with existing company, we need to assign them manually
        console.log("Assigning new customer to existing company:", { companyId, customerId });

        const assignNewCustomerResp = await admin.graphql(
          `#graphql
            mutation AssignNewCustomerAsContact($companyId: ID!, $customerId: ID!) {
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

        const assignNewCustomerJson = await assignNewCustomerResp.json();
        console.log("Assign new customer to existing company response:", JSON.stringify(assignNewCustomerJson, null, 2));

        if (assignNewCustomerJson.data?.companyAssignCustomerAsContact?.userErrors?.length > 0) {
          console.error("Failed to assign new customer to existing company:", assignNewCustomerJson.data.companyAssignCustomerAsContact.userErrors);
        } else {
          console.log("New customer successfully assigned to existing company");
        }
      } else {
        // 3c. For new customers created with new company, they should already be assigned via companyCreate
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