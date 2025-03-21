
const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 21
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  moderators: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  members: {
    type: Number,
    default: 1
  },
  rules: [{
    title: String,
    description: String
  }],
  banner: {
    type: String
  },
  icon: {
    type: String
  },
  type: {
    type: String,
    enum: ['public', 'restricted', 'private'],
    default: 'public'
  }
}, { timestamps: true });

module.exports = mongoose.model('Community', communitySchema);
