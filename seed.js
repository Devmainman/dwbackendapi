// Import models



// seed.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables from .env
dotenv.config();

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🌱 Starting database seeding...');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('MONGO_URI exists:', !!process.env.MONGO_URI);

if (!process.env.MONGO_URI) {
  console.error('❌ Error: MONGO_URI is not defined in .env file');
  process.exit(1);
}

// Import models
import Admin from './././src/models/Admin.js';
import User from './././src/models/User.js';
import MiningPool from './././src/models/MiningPool.js';
import MiningEquipment from './././src/models/MiningEquipment.js';
import MiningSession from './././src/models/MiningSession.js';
import MiningReward from './././src/models/MiningReward.js';
import MiningBooster from './././src/models/MiningBooster.js';

// Connect to MongoDB
const connectDB = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected successfully!');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};

// Check if any user exists (we'll use the first user as "admin" for mining)
const findAnyUser = async () => {
  try {
    // First, check if there's a regular user with admin email
    let user = await User.findOne({ email: 'admin@example.com' });
    
    if (!user) {
      // Try to find any user
      user = await User.findOne();
      
      if (!user) {
        console.error('❌ No users found in the database!');
        console.log('\n💡 You need to have at least one user to seed mining data.');
        console.log('   Options:');
        console.log('   1. Register a user through your app');
        console.log('   2. Create a test user manually in MongoDB');
        console.log('\n   Mining data needs to be associated with a user.');
        process.exit(1);
      }
    }
    
    console.log(`✅ Found user: ${user.email}`);
    return user;
  } catch (err) {
    console.error('❌ Error finding user:', err.message);
    process.exit(1);
  }
};

// Seed Mining Pools
const seedMiningPools = async () => {
  try {
    const pools = [
      {
        name: 'Bitcoin Pool Pro',
        url: 'stratum+tcp://btc.pool.pro:3333',
        fee: 1.5,
        minPayout: 0.001,
        miners: 1500,
        hashRate: 150, // TH/s
        uptime: 99.9,
        algorithm: 'SHA-256',
        supportedCoins: ['BTC'],
        paymentMethod: 'PPS',
        location: {
          country: 'USA',
          city: 'New York',
          latency: 25
        },
        status: 'active',
        features: ['ssl', 'stratum', 'api', 'monitoring', 'automatic_payout'],
        statistics: {
          totalBlocks: 1250,
          lastBlock: new Date(Date.now() - 3600000),
          avgBlockTime: 600,
          totalPayouts: 45000
        }
      },
      {
        name: 'Ethereum Elite Pool',
        url: 'stratum+tcp://eth.elite:4444',
        fee: 1.0,
        minPayout: 0.01,
        miners: 2500,
        hashRate: 280, // GH/s
        uptime: 99.8,
        algorithm: 'Ethash',
        supportedCoins: ['ETH', 'ETC'],
        paymentMethod: 'PPLNS',
        location: {
          country: 'Germany',
          city: 'Frankfurt',
          latency: 45
        },
        status: 'active',
        features: ['ssl', 'stratum', 'api', 'notifications'],
        statistics: {
          totalBlocks: 890,
          lastBlock: new Date(Date.now() - 1800000),
          avgBlockTime: 13,
          totalPayouts: 32000
        }
      },
      {
        name: 'Multi-Coin Pool',
        url: 'stratum+tcp://multi.pool:5555',
        fee: 2.0,
        minPayout: 0.005,
        miners: 1800,
        hashRate: 95, // TH/s
        uptime: 99.5,
        algorithm: 'RandomX',
        supportedCoins: ['XMR', 'RVN', 'ZEC'],
        paymentMethod: 'PROP',
        location: {
          country: 'Singapore',
          city: 'Singapore',
          latency: 15
        },
        status: 'active',
        features: ['ssl', 'stratum', 'api', 'notifications', 'monitoring'],
        statistics: {
          totalBlocks: 650,
          lastBlock: new Date(Date.now() - 2700000),
          avgBlockTime: 120,
          totalPayouts: 28000
        }
      },
      {
        name: 'Litecoin Mining Hub',
        url: 'stratum+tcp://ltc.hub:7777',
        fee: 1.8,
        minPayout: 0.1,
        miners: 1200,
        hashRate: 320, // GH/s
        uptime: 99.7,
        algorithm: 'Scrypt',
        supportedCoins: ['LTC', 'DOGE'],
        paymentMethod: 'SOLO',
        location: {
          country: 'Canada',
          city: 'Toronto',
          latency: 60
        },
        status: 'active',
        features: ['ssl', 'stratum', 'api'],
        statistics: {
          totalBlocks: 420,
          lastBlock: new Date(Date.now() - 4200000),
          avgBlockTime: 150,
          totalPayouts: 19000
        }
      }
    ];

    const createdPools = await MiningPool.insertMany(pools);
    console.log(`✅ Created ${createdPools.length} mining pools`);
    return createdPools;
  } catch (err) {
    console.error('❌ Error creating mining pools:', err.message);
    return [];
  }
};

// Seed Mining Equipment Templates
const seedMiningEquipment = async (userId) => {
  try {
    const equipment = [
      {
        userId: userId,
        name: 'NVIDIA RTX 4090',
        type: 'GPU',
        hashRate: 120, // MH/s
        powerConsumption: 450,
        efficiency: 0.27,
        status: 'active',
        temperature: 65,
        purchasePrice: 1599,
        totalRuntime: 86400,
        image: '/icons/gpu.png',
        specifications: {
          manufacturer: 'NVIDIA',
          model: 'RTX 4090',
          memory: '24GB GDDR6X',
          coreClock: '2235 MHz',
          releaseDate: new Date('2022-10-12')
        }
      },
      {
        userId: userId,
        name: 'Bitmain Antminer S19 Pro',
        type: 'ASIC',
        hashRate: 110, // TH/s
        powerConsumption: 3250,
        efficiency: 29.5,
        status: 'active',
        temperature: 75,
        purchasePrice: 2899,
        totalRuntime: 259200,
        image: '/icons/asic.png',
        specifications: {
          manufacturer: 'Bitmain',
          model: 'Antminer S19 Pro',
          memory: 'N/A',
          coreClock: 'N/A',
          releaseDate: new Date('2020-05-01')
        }
      },
      {
        userId: userId,
        name: 'AMD Radeon RX 7900 XTX',
        type: 'GPU',
        hashRate: 85, // MH/s
        powerConsumption: 355,
        efficiency: 0.24,
        status: 'idle',
        temperature: 70,
        purchasePrice: 999,
        totalRuntime: 43200,
        image: '/icons/gpu.png',
        specifications: {
          manufacturer: 'AMD',
          model: 'Radeon RX 7900 XTX',
          memory: '24GB GDDR6',
          coreClock: '2300 MHz',
          releaseDate: new Date('2022-12-13')
        }
      }
    ];

    const createdEquipment = await MiningEquipment.insertMany(equipment);
    console.log(`✅ Created ${createdEquipment.length} mining equipment`);
    return createdEquipment;
  } catch (err) {
    console.error('❌ Error creating mining equipment:', err.message);
    return [];
  }
};

// Seed Mining Sessions
const seedMiningSessions = async (userId, poolId, equipmentIds) => {
  try {
    const sessions = [
      {
        userId: userId,
        poolId: poolId,
        equipment: equipmentIds,
        hashRate: 120 + 110, // RTX 4090 + S19 Pro
        powerConsumption: 450 + 3250,
        status: 'active',
        startedAt: new Date(Date.now() - 7200000), // 2 hours ago
        duration: 7200,
        earnings: 0.00543,
        rewards: [
          {
            coin: 'BTC',
            amount: 0.00543,
            value: 250.45
          }
        ]
      },
      {
        userId: userId,
        poolId: poolId,
        equipment: [equipmentIds[0]], // Only RTX 4090
        hashRate: 120,
        powerConsumption: 450,
        status: 'completed',
        startedAt: new Date(Date.now() - 172800000), // 2 days ago
        endedAt: new Date(Date.now() - 86400000), // 1 day ago
        duration: 86400, // 24 hours
        earnings: 0.00128,
        rewards: [
          {
            coin: 'BTC',
            amount: 0.00128,
            value: 58.75
          }
        ]
      }
    ];

    const createdSessions = await MiningSession.insertMany(sessions);
    console.log(`✅ Created ${createdSessions.length} mining sessions`);
    return createdSessions;
  } catch (err) {
    console.error('❌ Error creating mining sessions:', err.message);
    return [];
  }
};

// Seed Mining Rewards
const seedMiningRewards = async (userId, sessionId) => {
  try {
    const rewards = [
      {
        userId: userId,
        sessionId: sessionId,
        coin: 'BTC',
        amount: 0.00543,
        value: 250.45,
        status: 'pending',
        confirmed: false,
        confirmations: 2
      },
      {
        userId: userId,
        coin: 'ETH',
        amount: 0.125,
        value: 450.25,
        status: 'claimed',
        claimedAt: new Date(Date.now() - 86400000),
        confirmed: true,
        confirmations: 12
      },
      {
        userId: userId,
        coin: 'LTC',
        amount: 2.5,
        value: 325.75,
        status: 'pending',
        confirmed: false,
        confirmations: 6
      },
      {
        userId: userId,
        coin: 'BTC',
        amount: 0.00128,
        value: 58.75,
        status: 'claimed',
        claimedAt: new Date(Date.now() - 259200000), // 3 days ago
        confirmed: true,
        confirmations: 24
      }
    ];

    const createdRewards = await MiningReward.insertMany(rewards);
    console.log(`✅ Created ${createdRewards.length} mining rewards`);
    return createdRewards;
  } catch (err) {
    console.error('❌ Error creating mining rewards:', err.message);
    return [];
  }
};

// Seed Mining Boosters
const seedMiningBoosters = async (userId) => {
  try {
    const boosters = [
      {
        userId: userId,
        name: 'Hash Rate Boost',
        type: 'hash_rate',
        multiplier: 1.5,
        duration: 3600, // 1 hour
        price: 10,
        status: 'active',
        expiresAt: new Date(Date.now() + 3600000) // 1 hour from now
      },
      {
        userId: userId,
        name: 'Energy Saver',
        type: 'energy',
        multiplier: 0.8,
        duration: 7200, // 2 hours
        price: 15,
        status: 'expired',
        expiresAt: new Date(Date.now() - 86400000) // 1 day ago
      },
      {
        userId: userId,
        name: 'Double Rewards',
        type: 'rewards',
        multiplier: 2,
        duration: 1800, // 30 minutes
        price: 25,
        status: 'active',
        expiresAt: new Date(Date.now() + 900000) // 15 minutes from now
      }
    ];

    const createdBoosters = await MiningBooster.insertMany(boosters);
    console.log(`✅ Created ${createdBoosters.length} mining boosters`);
    return createdBoosters;
  } catch (err) {
    console.error('❌ Error creating mining boosters:', err.message);
    return [];
  }
};

// Main seeding function
const seedDatabase = async () => {
  try {
    await connectDB();
    
    // Find any user to associate mining data with
    console.log('👤 Looking for a user to associate mining data with...');
    const user = await findAnyUser();
    
    // Ask for confirmation
    console.log(`\n⚠️  Mining data will be associated with: ${user.email}`);
    console.log('   Type "yes" to continue or anything else to exit:');
    
    // For simplicity, we'll just proceed. In production, you might want to add a prompt.
    console.log('Proceeding with seeding...\n');
    
    // Clear existing mining data
    console.log('🧹 Clearing existing mining data...');
    await MiningPool.deleteMany({});
    await MiningEquipment.deleteMany({});
    await MiningSession.deleteMany({});
    await MiningReward.deleteMany({});
    await MiningBooster.deleteMany({});
    
    // Seed mining pools
    console.log('🏊 Seeding mining pools...');
    const pools = await seedMiningPools();
    
    if (pools.length === 0) {
      throw new Error('Failed to create mining pools');
    }
    
    // Seed mining equipment for the user
    console.log('⚙️ Seeding mining equipment...');
    const equipment = await seedMiningEquipment(user._id);
    
    if (equipment.length === 0) {
      throw new Error('Failed to create mining equipment');
    }
    
    // Seed mining sessions
    console.log('⛏️ Seeding mining sessions...');
    const equipmentIds = equipment.map(eq => eq._id);
    const sessions = await seedMiningSessions(user._id, pools[0]._id, equipmentIds);
    
    // Seed mining rewards
    console.log('💰 Seeding mining rewards...');
    if (sessions.length > 0) {
      await seedMiningRewards(user._id, sessions[0]._id);
    } else {
      await seedMiningRewards(user._id, null);
    }
    
    // Seed mining boosters
    console.log('🚀 Seeding mining boosters...');
    await seedMiningBoosters(user._id);
    
    console.log('\n🎉 Database seeding completed successfully!');
    console.log('📊 Summary:');
    console.log(`   • ${pools.length} mining pools`);
    console.log(`   • ${equipment.length} mining equipment`);
    console.log(`   • ${sessions.length} mining sessions`);
    console.log(`   • 4 mining rewards`);
    console.log(`   • 3 mining boosters`);
    console.log(`\n👤 Associated with user: ${user.email}`);
    console.log('\n🔗 You can now access mining features at:');
    console.log('   - GET /api/mining/stats');
    console.log('   - POST /api/mining/start');
    console.log('   - GET /api/mining/equipment');
    console.log('\n🔑 Admin mining routes (if logged in as admin):');
    console.log('   - GET /api/admin/mining/stats');
    console.log('   - GET /api/admin/mining/sessions');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Database seeding failed:', err.message);
    process.exit(1);
  }
};

// Run the seed script
seedDatabase();