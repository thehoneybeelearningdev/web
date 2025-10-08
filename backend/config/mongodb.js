const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB_NAME || 'honeybee_education';

let client;
let db;

const connectDB = async () => {
  try {
    client = new MongoClient(uri);
          await client.connect();
      db = client.db(dbName);
      return db;
  } catch (error) {
    process.exit(1);
  }
};

const getDB = () => {
  if (!db) {
    throw new Error('Database not connected. Call connectDB() first.');
  }
  return db;
};

const closeDB = async () => {
      if (client) {
      await client.close();
    }
};

module.exports = { connectDB, getDB, closeDB };
