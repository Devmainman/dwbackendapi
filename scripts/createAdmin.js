// Create or reset an admin account from the command line.
// Usage: npm run create-admin -- admin@example.com "a-strong-password"
import mongoose from 'mongoose';
import '../src/config/env.js';
import Admin from '../src/models/Admin.js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: npm run create-admin -- <email> <password>');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Admin password must be at least 12 characters.');
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
let admin = await Admin.findOne({ email: email.toLowerCase() });
if (admin) {
  admin.password = password;
  await admin.save();
  console.log(`Password reset for admin ${admin.email}`);
} else {
  admin = await Admin.create({ email, password });
  console.log(`Admin created: ${admin.email}`);
}
await mongoose.disconnect();
