const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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

    // ==================== PARCEL APIs ====================

    // Get all parcels (for admin)
    app.get("/parcels", async (req, res) => {
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

    // Create a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;

        // Validate required fields
        if (!parcelData.senderEmail) {
          return res.status(400).json({
            success: false,
            message: "Sender email is required",
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

    // Get all parcels for a user (by sender email)
    app.get("/parcels/user/:email", async (req, res) => {
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

    // Process payment for a parcel
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
