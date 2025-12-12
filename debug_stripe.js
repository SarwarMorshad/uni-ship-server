// Debug script to check Stripe payment intent structure
// Run this separately to see what data Stripe returns

require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

async function debugPaymentIntent(paymentIntentId) {
  try {
    console.log("\n=== Retrieving Payment Intent (With Expansion) ===");
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["charges.data"],
    });

    console.log("Payment Intent ID:", pi.id);
    console.log("Payment Method ID:", pi.payment_method);
    console.log("Latest Charge ID:", pi.latest_charge);
    console.log("Status:", pi.status);

    if (pi.charges && pi.charges.data.length > 0) {
      const charge = pi.charges.data[0];
      console.log("\n=== Charge Details ===");
      console.log("Charge ID:", charge.id);
      console.log("Payment Method ID:", charge.payment_method);
      console.log("Receipt URL:", charge.receipt_url);

      if (charge.payment_method_details) {
        console.log("\n=== Payment Method Details (from charge) ===");
        console.log(JSON.stringify(charge.payment_method_details, null, 2));
      }

      // If no receipt URL in expanded data, try fetching charge directly
      if (!charge.receipt_url) {
        console.log("\n=== Fetching Charge Directly (for receipt URL) ===");
        const fullCharge = await stripe.charges.retrieve(charge.id);
        console.log("Receipt URL from direct fetch:", fullCharge.receipt_url);
      }
    }

    // Fetch payment method separately
    if (pi.payment_method) {
      console.log("\n=== Fetching Payment Method Separately ===");
      const pm = await stripe.paymentMethods.retrieve(pi.payment_method);
      console.log("Payment Method Type:", pm.type);
      if (pm.card) {
        console.log("Card Brand:", pm.card.brand);
        console.log("Card Last4:", pm.card.last4);
        console.log("Card Exp:", pm.card.exp_month + "/" + pm.card.exp_year);
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Usage: Replace with your actual payment intent ID
const paymentIntentId = "pi_3SdGuwBehxKY2BY90WdbQZwi"; // From your payment record
debugPaymentIntent(paymentIntentId);
