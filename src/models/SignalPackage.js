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