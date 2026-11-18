import mongoose from 'mongoose';


const signalPackageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },


  strength: {
    type: Number, // how much signal power this gives user
    required: true,
    min: 0,
    max: 100
  },


  amount: {
    type: Number,
    required: true
  },


  // What the admin typed for strength when it is more than a number, e.g. "20 +".
  strengthLabel: { type: String, default: "" },

  benefits: [String],


  icon: {
    type: String,
    default: ''
  },


  active: {
    type: Boolean,
    default: true
  }


}, { timestamps: true });


const SignalPackage = mongoose.model('SignalPackage', signalPackageSchema);
export default SignalPackage;