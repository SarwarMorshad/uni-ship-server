const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// ==========================================
// FIREBASE ADMIN SDK INITIALIZATION
// ==========================================
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase Admin SDK initialized");

const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.cjj6frc.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();

    // Database and Collections
    const database = client.db("unishiftDB");
    const parcelsCollection = database.collection("parcels");
    const paymentsCollection = database.collection("payments");
    const usersCollection = database.collection("users");

    // ==========================================
    // JWT AUTHENTICATION MIDDLEWARE
    // ==========================================

    /**
     * Verify Firebase JWT Token
     * Extracts token from Authorization header and verifies with Firebase Admin SDK
     */
    const verifyToken = async (req, res, next) => {
      try {
        // Get token from Authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).json({
            success: false,
            message: "Unauthorized: No token provided",
          });
        }

        // Extract token (remove "Bearer " prefix)
        const token = authHeader.split(" ")[1];

        // Verify token with Firebase Admin SDK
        const decodedToken = await admin.auth().verifyIdToken(token);

        // Attach user info to request object
        req.user = {
          uid: decodedToken.uid,
          email: decodedToken.email,
          emailVerified: decodedToken.email_verified,
        };

        console.log("✅ Token verified for user:", req.user.email);
        next();
      } catch (error) {
        console.error("❌ Token verification error:", error.code);

        if (error.code === "auth/id-token-expired") {
          return res.status(401).json({
            success: false,
            message: "Token expired. Please login again.",
          });
        }

        if (error.code === "auth/argument-error") {
          return res.status(401).json({
            success: false,
            message: "Invalid token format",
          });
        }

        return res.status(401).json({
          success: false,
          message: "Invalid token",
        });
      }
    };

    /**
     * Verify Admin Role
     * Must be used after verifyToken middleware
     * Checks if authenticated user has admin role in database
     */
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.user.email;

        // Get user from database
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found in database",
          });
        }

        if (user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Forbidden: Admin access required",
          });
        }

        // Attach full user data to request
        req.userData = user;

        console.log("✅ Admin verified:", email);
        next();
      } catch (error) {
        console.error("❌ Admin verification error:", error);
        return res.status(500).json({
          success: false,
          message: "Error verifying admin status",
        });
      }
    };

    /**
     * Verify Rider Role
     * Must be used after verifyToken middleware
     */
    const verifyRider = async (req, res, next) => {
      try {
        const email = req.user.email;
        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "rider") {
          return res.status(403).json({
            success: false,
            message: "Forbidden: Rider access required",
          });
        }

        req.userData = user;
        console.log("✅ Rider verified:", email);
        next();
      } catch (error) {
        console.error("❌ Rider verification error:", error);
        return res.status(500).json({
          success: false,
          message: "Error verifying rider status",
        });
      }
    };

    /**
     * Verify User Can Access Own Data
     * Checks if user is accessing their own data or is admin
     */
    const verifyOwnDataOrAdmin = async (req, res, next) => {
      try {
        const requestedEmail = req.params.email;
        const userEmail = req.user.email;

        // If requesting own data, allow
        if (requestedEmail === userEmail) {
          return next();
        }

        // Check if user is admin
        const user = await usersCollection.findOne({ email: userEmail });
        if (user?.role === "admin") {
          req.userData = user;
          return next();
        }

        // Not own data and not admin
        return res.status(403).json({
          success: false,
          message: "Forbidden: Can only access your own data",
        });
      } catch (error) {
        console.error("❌ Access verification error:", error);
        return res.status(500).json({
          success: false,
          message: "Error verifying access",
        });
      }
    };

    // ==================== PARCEL APIs ====================

    // Get all parcels (ADMIN ONLY)
    app.get("/parcels", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const parcels = await parcelsCollection.find({}).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          count: parcels.length,
          parcels: parcels,
        });
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch parcels",
          error: error.message,
        });
      }
    });

    // Create a new parcel (PROTECTED - Auth Required)
    app.post("/parcels", verifyToken, async (req, res) => {
      try {
        const parcelData = req.body;

        // Validate required fields
        if (!parcelData.senderEmail) {
          return res.status(400).json({
            success: false,
            message: "Sender email is required",
          });
        }

        // Verify user is creating parcel for themselves
        if (parcelData.senderEmail !== req.user.email) {
          return res.status(403).json({
            success: false,
            message: "Can only create parcels for your own email",
          });
        }

        // Add server-side data
        const parcel = {
          ...parcelData,
          status: "unpaid",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await parcelsCollection.insertOne(parcel);

        res.status(201).json({
          success: true,
          message: "Parcel created successfully",
          parcelId: result.insertedId,
        });
      } catch (error) {
        console.error("Error creating parcel:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create parcel",
          error: error.message,
        });
      }
    });

    // Get all parcels for a user (PROTECTED - Own data or Admin)
    app.get("/parcels/user/:email", verifyToken, verifyOwnDataOrAdmin, async (req, res) => {
      try {
        const email = req.params.email;
        const parcels = await parcelsCollection
          .find({ senderEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({
          success: true,
          count: parcels.length,
          parcels: parcels,
        });
      } catch (error) {
        console.error("Error fetching user parcels:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch parcels",
          error: error.message,
        });
      }
    });

    // Get unpaid parcels for a user
    app.get("/parcels/user/:email/unpaid", async (req, res) => {
      try {
        const email = req.params.email;
        const parcels = await parcelsCollection
          .find({
            senderEmail: email,
            status: "unpaid",
          })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({
          success: true,
          count: parcels.length,
          parcels: parcels,
        });
      } catch (error) {
        console.error("Error fetching unpaid parcels:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch unpaid parcels",
          error: error.message,
        });
      }
    });

    // Get parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid parcel ID",
          });
        }

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({
            success: false,
            message: "Parcel not found",
          });
        }

        res.status(200).json({
          success: true,
          parcel: parcel,
        });
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch parcel",
          error: error.message,
        });
      }
    });

    // Delete unpaid parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid parcel ID",
          });
        }

        // Check if parcel is unpaid
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({
            success: false,
            message: "Parcel not found",
          });
        }

        if (parcel.status !== "unpaid") {
          return res.status(400).json({
            success: false,
            message: "Only unpaid parcels can be deleted",
          });
        }

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.status(200).json({
          success: true,
          message: "Parcel deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete parcel",
          error: error.message,
        });
      }
    });

    // Search parcels by receiver phone
    app.get("/parcels/search/phone/:phone", async (req, res) => {
      try {
        const phone = req.params.phone;
        const email = req.query.email; // User's email from query params

        const parcels = await parcelsCollection
          .find({
            senderEmail: email,
            receiverPhone: phone,
          })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({
          success: true,
          count: parcels.length,
          parcels: parcels,
        });
      } catch (error) {
        console.error("Error searching parcels:", error);
        res.status(500).json({
          success: false,
          message: "Failed to search parcels",
          error: error.message,
        });
      }
    });

    // ==================== PAYMENT API ====================

    // Create Stripe Checkout Session
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { parcelId, amount, parcelName, customerEmail } = req.body;

        // Validate parcel
        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid parcel ID",
          });
        }

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).json({
            success: false,
            message: "Parcel not found",
          });
        }

        if (parcel.status !== "unpaid") {
          return res.status(400).json({
            success: false,
            message: "Parcel is already paid",
          });
        }

        // Convert BDT to USD cents (1 USD = 110 BDT, approximately)
        // Stripe requires amount in cents
        const amountInUSD = Math.round((amount / 110) * 100); // Convert to USD cents

        // Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: customerEmail, // Pre-fill email (editable)
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: `Parcel Delivery - ${parcelName}`,
                  description: `Delivery from ${parcel.senderDistrict} to ${parcel.receiverDistrict}`,
                },
                unit_amount: amountInUSD,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}&parcel_id=${parcelId}`,
          cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled/${parcelId}`,
          metadata: {
            parcelId: parcelId.toString(),
            amount: amount.toString(),
            customerEmail: customerEmail,
          },
        });

        res.status(200).json({
          success: true,
          sessionId: session.id,
          url: session.url,
        });
      } catch (error) {
        console.error("Error creating checkout session:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create checkout session",
          error: error.message,
        });
      }
    });

    // Verify payment and update parcel
    app.post("/verify-payment", async (req, res) => {
      try {
        const { sessionId, parcelId } = req.body;

        // Check if payment already exists for this session
        const existingPayment = await paymentsCollection.findOne({
          stripeSessionId: sessionId,
        });

        if (existingPayment) {
          return res.status(200).json({
            success: true,
            message: "Payment already verified",
            tracking_no: existingPayment.trackingNumber,
          });
        }

        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).json({
            success: false,
            message: "Payment not completed",
          });
        }

        // Check if parcel exists
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).json({
            success: false,
            message: "Parcel not found",
          });
        }

        // Check if parcel already paid
        if (parcel.status !== "unpaid") {
          return res.status(200).json({
            success: true,
            message: "Payment already verified",
            tracking_no: parcel.tracking_no,
          });
        }

        // Generate tracking number
        const timestamp = Date.now().toString().slice(-8);
        const random = Math.floor(Math.random() * 100)
          .toString()
          .padStart(2, "0");
        const tracking_no = `ZS${timestamp}${random}`;

        // Get payment details from Stripe
        let cardDetails = { last4: null, brand: null };
        let transactionId = null;

        try {
          // Retrieve payment intent (can't expand charges.data.payment_method, so don't)
          const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent, {
            expand: ["charges.data"],
          });

          console.log("Payment Intent Retrieved:", {
            id: paymentIntent.id,
            paymentMethod: paymentIntent.payment_method,
            latestCharge: paymentIntent.latest_charge,
            hasCharges: !!paymentIntent.charges,
            chargesCount: paymentIntent.charges?.data?.length || 0,
          });

          // Get transaction ID from latest_charge
          if (paymentIntent.latest_charge) {
            transactionId = paymentIntent.latest_charge;
            console.log("Transaction ID from latest_charge:", transactionId);
          }

          // Get charge details
          if (paymentIntent.charges && paymentIntent.charges.data.length > 0) {
            const charge = paymentIntent.charges.data[0];
            console.log("Charge found:", {
              id: charge.id,
              hasPaymentMethodDetails: !!charge.payment_method_details,
            });

            // Override transaction ID with actual charge ID
            transactionId = charge.id;

            // Get card details from payment_method_details
            if (charge.payment_method_details?.card) {
              console.log("Using payment_method_details from charge");
              cardDetails.last4 = charge.payment_method_details.card.last4;
              cardDetails.brand = charge.payment_method_details.card.brand;
            }
          }

          // Fallback: If no card details yet, fetch payment method separately
          if (!cardDetails.last4 && paymentIntent.payment_method) {
            console.log("Fetching payment method separately:", paymentIntent.payment_method);
            try {
              const paymentMethod = await stripe.paymentMethods.retrieve(paymentIntent.payment_method);

              console.log("Payment method retrieved:", {
                id: paymentMethod.id,
                type: paymentMethod.type,
                hasCard: !!paymentMethod.card,
              });

              if (paymentMethod.card) {
                cardDetails.last4 = paymentMethod.card.last4;
                cardDetails.brand = paymentMethod.card.brand;
              }
            } catch (pmError) {
              console.error("Failed to retrieve payment method:", pmError.message);
            }
          }

          console.log("Final results:", {
            transactionId,
            cardDetails,
          });
        } catch (cardError) {
          console.error("Error retrieving payment details:", cardError.message);
          // Continue without card details
        }

        // Create payment record
        const paymentRecord = {
          parcelId: new ObjectId(parcelId),
          userId: parcel.senderEmail,
          userName: parcel.senderName,

          // Payment details
          amount: parcel.cost, // Original amount in BDT
          amountPaidUSD: session.amount_total / 100, // Amount paid in USD
          currency: session.currency,
          paymentMethod: "stripe",
          paymentStatus: "succeeded",

          // Stripe details
          stripeSessionId: sessionId,
          stripePaymentIntentId: session.payment_intent,
          stripeTransactionId: transactionId, // Charge ID (Transaction ID)
          stripeCustomerEmail: session.customer_email || session.customer_details?.email,

          // Card details
          paymentDetails: cardDetails,

          // Parcel info
          parcelName: parcel.parcelName,
          trackingNumber: tracking_no,
          route: `${parcel.senderDistrict} → ${parcel.receiverDistrict}`,

          // Timestamps
          paidAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };

        // Save payment record
        await paymentsCollection.insertOne(paymentRecord);

        // Update parcel with payment info
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              status: "paid",
              tracking_no: tracking_no,
              paymentMethod: "stripe",
              stripeSessionId: sessionId,
              stripePaymentIntentId: session.payment_intent,
              stripeTransactionId: transactionId,
              paidAmount: session.amount_total / 100, // Convert cents to dollars
              paidAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.modifiedCount === 0) {
          return res.status(500).json({
            success: false,
            message: "Failed to update parcel",
          });
        }

        res.status(200).json({
          success: true,
          message: "Payment verified successfully",
          tracking_no: tracking_no,
        });
      } catch (error) {
        console.error("Error verifying payment:", error);
        res.status(500).json({
          success: false,
          message: "Failed to verify payment",
          error: error.message,
        });
      }
    });

    // Process payment for a parcel (Cash on Delivery)
    app.post("/parcels/:id/pay", async (req, res) => {
      try {
        const id = req.params.id;
        const { paymentMethod, amount } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid parcel ID",
          });
        }

        // Check if parcel exists
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({
            success: false,
            message: "Parcel not found",
          });
        }

        // Check if already paid
        if (parcel.status !== "unpaid") {
          return res.status(400).json({
            success: false,
            message: "Parcel is already paid",
          });
        }

        // Generate tracking number
        const timestamp = Date.now().toString().slice(-8);
        const random = Math.floor(Math.random() * 100)
          .toString()
          .padStart(2, "0");
        const tracking_no = `ZS${timestamp}${random}`;

        // Update parcel with payment info
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "paid",
              tracking_no: tracking_no,
              paymentMethod: paymentMethod,
              paidAmount: amount,
              paidAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.modifiedCount === 0) {
          return res.status(500).json({
            success: false,
            message: "Failed to process payment",
          });
        }

        res.status(200).json({
          success: true,
          message: "Payment processed successfully",
          tracking_no: tracking_no,
          parcel: {
            _id: id,
            tracking_no: tracking_no,
            status: "paid",
          },
        });
      } catch (error) {
        console.error("Error processing payment:", error);
        res.status(500).json({
          success: false,
          message: "Failed to process payment",
          error: error.message,
        });
      }
    });

    // ==================== PAYMENT MANAGEMENT APIs ====================

    // Get all payments (Admin)
    app.get("/payments", async (req, res) => {
      try {
        const payments = await paymentsCollection.find({}).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          count: payments.length,
          payments: payments,
        });
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch payments",
          error: error.message,
        });
      }
    });

    // Get payments by user email
    app.get("/payments/user/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const payments = await paymentsCollection.find({ userId: email }).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          count: payments.length,
          payments: payments,
        });
      } catch (error) {
        console.error("Error fetching user payments:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch payments",
          error: error.message,
        });
      }
    });

    // Get payment by ID
    app.get("/payments/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid payment ID",
          });
        }

        const payment = await paymentsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!payment) {
          return res.status(404).json({
            success: false,
            message: "Payment not found",
          });
        }

        res.status(200).json({
          success: true,
          payment: payment,
        });
      } catch (error) {
        console.error("Error fetching payment:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch payment",
          error: error.message,
        });
      }
    });

    // Get payment statistics (Admin)
    app.get("/payments/stats/overview", async (req, res) => {
      try {
        const totalPayments = await paymentsCollection.countDocuments();

        const payments = await paymentsCollection.find({}).toArray();

        const totalRevenueBDT = payments.reduce((sum, payment) => sum + payment.amount, 0);
        const totalRevenueUSD = payments.reduce((sum, payment) => sum + payment.amountPaidUSD, 0);

        const successfulPayments = payments.filter((p) => p.paymentStatus === "succeeded").length;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayPayments = payments.filter((p) => new Date(p.createdAt) >= todayStart);
        const todayRevenueBDT = todayPayments.reduce((sum, payment) => sum + payment.amount, 0);

        res.status(200).json({
          success: true,
          stats: {
            totalPayments,
            successfulPayments,
            totalRevenueBDT: Math.round(totalRevenueBDT),
            totalRevenueUSD: totalRevenueUSD.toFixed(2),
            todayPayments: todayPayments.length,
            todayRevenueBDT: Math.round(todayRevenueBDT),
            averageTransactionBDT: Math.round(totalRevenueBDT / totalPayments) || 0,
          },
        });
      } catch (error) {
        console.error("Error fetching payment stats:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch payment statistics",
          error: error.message,
        });
      }
    });

    // ==================== USER MANAGEMENT APIs ====================

    // Create User (After Firebase Registration)
    app.post("/users", async (req, res) => {
      try {
        const { email, displayName, photoURL } = req.body;

        // Validate required fields
        if (!email) {
          return res.status(400).json({
            success: false,
            message: "Email is required",
          });
        }

        // Check if user already exists
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(200).json({
            success: true,
            message: "User already exists",
            user: existingUser,
          });
        }

        // Check if this should be an admin (from environment variable)
        const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim()) || [];
        const role = adminEmails.includes(email) ? "admin" : "user";

        // Create new user
        const newUser = {
          email,
          displayName: displayName || "User",
          photoURL: photoURL || null,
          role, // 'user', 'admin', or 'rider'
          status: "active", // 'active', 'suspended', 'banned'
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(newUser);

        res.status(201).json({
          success: true,
          message: "User created successfully",
          user: { ...newUser, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create user",
          error: error.message,
        });
      }
    });

    // Get User by Email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        // Update last login
        await usersCollection.updateOne(
          { email },
          {
            $set: {
              lastLogin: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        );

        res.status(200).json({
          success: true,
          user,
        });
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch user",
          error: error.message,
        });
      }
    });

    // Get All Users (Admin Only - add verifyAdmin middleware in production)
    app.get("/users", async (req, res) => {
      try {
        const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          count: users.length,
          users,
        });
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch users",
          error: error.message,
        });
      }
    });

    // Check if user is admin
    app.get("/users/:email/check-admin", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        res.status(200).json({
          success: true,
          isAdmin: user?.role === "admin",
          role: user?.role || "user",
        });
      } catch (error) {
        console.error("Error checking admin status:", error);
        res.status(500).json({
          success: false,
          message: "Failed to check admin status",
          error: error.message,
        });
      }
    });

    // Update User Role (Admin Only)
    app.patch("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const { role } = req.body;

        // Validate role
        const validRoles = ["user", "admin", "rider"];
        if (!validRoles.includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role. Must be 'user', 'admin', or 'rider'",
          });
        }

        // Update user role
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              role,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: `User role updated to ${role}`,
        });
      } catch (error) {
        console.error("Error updating user role:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update user role",
          error: error.message,
        });
      }
    });

    // Update User Status (Admin Only)
    app.patch("/users/:email/status", async (req, res) => {
      try {
        const email = req.params.email;
        const { status } = req.body;

        // Validate status
        const validStatuses = ["active", "suspended", "banned"];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status. Must be 'active', 'suspended', or 'banned'",
          });
        }

        // Update user status
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              status,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: `User status updated to ${status}`,
        });
      } catch (error) {
        console.error("Error updating user status:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update user status",
          error: error.message,
        });
      }
    });

    // Delete User (Admin Only)
    app.delete("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const result = await usersCollection.deleteOne({ email });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: "User deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete user",
          error: error.message,
        });
      }
    });

    // Get User Statistics (Admin Only)
    app.get("/users/stats/overview", async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const activeUsers = await usersCollection.countDocuments({ status: "active" });
        const adminUsers = await usersCollection.countDocuments({ role: "admin" });
        const riderUsers = await usersCollection.countDocuments({ role: "rider" });
        const suspendedUsers = await usersCollection.countDocuments({ status: "suspended" });

        // Get recent users (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentUsers = await usersCollection.countDocuments({
          createdAt: { $gte: sevenDaysAgo.toISOString() },
        });

        res.status(200).json({
          success: true,
          stats: {
            totalUsers,
            activeUsers,
            adminUsers,
            riderUsers,
            suspendedUsers,
            recentUsers,
          },
        });
      } catch (error) {
        console.error("Error fetching user statistics:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch user statistics",
          error: error.message,
        });
      }
    });

    // ==========================================
    // USER MANAGEMENT ENDPOINTS
    // ==========================================

    // Create User (After Firebase Registration)
    app.post("/users", async (req, res) => {
      try {
        const { email, displayName, photoURL } = req.body;

        // Validate required fields
        if (!email) {
          return res.status(400).json({
            success: false,
            message: "Email is required",
          });
        }

        // Check if user already exists
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(200).json({
            success: true,
            message: "User already exists",
            user: existingUser,
          });
        }

        // Check if this should be an admin (from environment variable)
        const adminEmails = process.env.ADMIN_EMAILS?.split(",").map((e) => e.trim()) || [];
        const role = adminEmails.includes(email) ? "admin" : "user";

        // Create new user
        const newUser = {
          email,
          displayName: displayName || "User",
          photoURL: photoURL || null,
          role, // 'user', 'admin', or 'rider'
          status: "active", // 'active', 'suspended', 'banned'
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(newUser);

        res.status(201).json({
          success: true,
          message: "User created successfully",
          user: { ...newUser, _id: result.insertedId },
        });
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to create user",
          error: error.message,
        });
      }
    });

    // Get User by Email
    app.get("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        // Update last login
        await usersCollection.updateOne(
          { email },
          {
            $set: {
              lastLogin: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        );

        res.status(200).json({
          success: true,
          user,
        });
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch user",
          error: error.message,
        });
      }
    });

    // Get All Users (Admin Only)
    app.get("/admin/users", async (req, res) => {
      try {
        const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          count: users.length,
          users,
        });
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch users",
          error: error.message,
        });
      }
    });

    // Update User Role (Admin Only)
    app.patch("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const { role } = req.body;

        // Validate role
        const validRoles = ["user", "admin", "rider"];
        if (!validRoles.includes(role)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role. Must be 'user', 'admin', or 'rider'",
          });
        }

        // Update user role
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              role,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: `User role updated to ${role}`,
        });
      } catch (error) {
        console.error("Error updating user role:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update user role",
          error: error.message,
        });
      }
    });

    // Update User Status (Admin Only)
    app.patch("/users/:email/status", async (req, res) => {
      try {
        const email = req.params.email;
        const { status } = req.body;

        // Validate status
        const validStatuses = ["active", "suspended", "banned"];
        if (!validStatuses.includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status. Must be 'active', 'suspended', or 'banned'",
          });
        }

        // Update user status
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: {
              status,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: `User status updated to ${status}`,
        });
      } catch (error) {
        console.error("Error updating user status:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update user status",
          error: error.message,
        });
      }
    });

    // Delete User (Admin Only)
    app.delete("/users/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const result = await usersCollection.deleteOne({ email });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        res.status(200).json({
          success: true,
          message: "User deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete user",
          error: error.message,
        });
      }
    });

    // Check if user is admin
    app.get("/users/:email/check-admin", async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });

        res.status(200).json({
          success: true,
          isAdmin: user?.role === "admin",
          role: user?.role || "user",
        });
      } catch (error) {
        console.error("Error checking admin status:", error);
        res.status(500).json({
          success: false,
          message: "Failed to check admin status",
          error: error.message,
        });
      }
    });

    // Get User Statistics (Admin Only)
    app.get("/users/stats/overview", async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const activeUsers = await usersCollection.countDocuments({ status: "active" });
        const adminUsers = await usersCollection.countDocuments({ role: "admin" });
        const riderUsers = await usersCollection.countDocuments({ role: "rider" });
        const suspendedUsers = await usersCollection.countDocuments({ status: "suspended" });

        // Get recent users (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentUsers = await usersCollection.countDocuments({
          createdAt: { $gte: sevenDaysAgo.toISOString() },
        });

        res.status(200).json({
          success: true,
          stats: {
            totalUsers,
            activeUsers,
            adminUsers,
            riderUsers,
            suspendedUsers,
            recentUsers,
          },
        });
      } catch (error) {
        console.error("Error fetching user statistics:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch user statistics",
          error: error.message,
        });
      }
    });

    // ==================== TEST ROUTE ====================

    app.get("/", (req, res) => {
      res.send("Uni Ship API is live! 🚀");
    });

    // Ping MongoDB
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Uni Ship API listening at http://localhost:${port}`);
});
