
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Community = require('../models/Community');
const { isAuthenticated } = require('../middleware/auth');

// Get all communities
router.get('/', async (req, res) => {
  try {
    const communities = await Community.find()
      .sort({ members: -1 })
      .populate('creator', 'username')
      .lean();
    
    res.json(communities);
  } catch (error) {
    console.error('Get communities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new community
router.post(
  '/',
  isAuthenticated,
  [
    body('name')
      .trim()
      .isLength({ min: 3, max: 21 })
      .withMessage('Community name must be between 3 and 21 characters')
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage('Community name can only contain letters, numbers and underscores')
      .escape(),
    body('description')
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description cannot exceed 500 characters')
      .escape(),
    body('type')
      .isIn(['public', 'restricted', 'private'])
      .withMessage('Invalid community type')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { name, description, type } = req.body;
      
      // Check if community already exists
      const existingCommunity = await Community.findOne({ name: name.toLowerCase() });
      if (existingCommunity) {
        return res.status(400).json({ message: 'Community already exists' });
      }
      
      // Create new community
      const newCommunity = new Community({
        name: name.toLowerCase(),
        description,
        type: type || 'public',
        creator: req.user._id,
        moderators: [req.user._id]
      });
      
      await newCommunity.save();
      
      // Populate creator info before sending response
      await newCommunity.populate('creator', 'username');
      
      res.status(201).json(newCommunity);
    } catch (error) {
      console.error('Create community error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Get a community by name
router.get('/:name', async (req, res) => {
  try {
    const community = await Community.findOne({ name: req.params.name.toLowerCase() })
      .populate('creator', 'username')
      .populate('moderators', 'username')
      .lean();
    
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }
    
    res.json(community);
  } catch (error) {
    console.error('Get community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a community
router.put(
  '/:name',
  isAuthenticated,
  [
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description cannot exceed 500 characters')
      .escape(),
    body('type')
      .optional()
      .isIn(['public', 'restricted', 'private'])
      .withMessage('Invalid community type'),
    body('rules')
      .optional()
      .isArray()
      .withMessage('Rules must be an array'),
    body('banner')
      .optional()
      .isURL()
      .withMessage('Banner must be a valid URL'),
    body('icon')
      .optional()
      .isURL()
      .withMessage('Icon must be a valid URL')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const community = await Community.findOne({ name: req.params.name.toLowerCase() });
      
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }
      
      // Check if user is a moderator
      if (!community.moderators.includes(req.user._id)) {
        return res.status(403).json({ message: 'Not authorized to update this community' });
      }
      
      // Update community fields
      const { description, type, rules, banner, icon } = req.body;
      
      if (description !== undefined) community.description = description;
      if (type !== undefined) community.type = type;
      if (rules !== undefined) community.rules = rules;
      if (banner !== undefined) community.banner = banner;
      if (icon !== undefined) community.icon = icon;
      
      await community.save();
      
      // Populate moderator info before sending response
      await community.populate('moderators', 'username');
      
      res.json(community);
    } catch (error) {
      console.error('Update community error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Add a moderator to a community
router.post(
  '/:name/moderators',
  isAuthenticated,
  [
    body('username').trim().not().isEmpty().withMessage('Username is required')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const community = await Community.findOne({ name: req.params.name.toLowerCase() });
      
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }
      
      // Check if user is the creator
      if (community.creator.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Only the community creator can add moderators' });
      }
      
      // Find user to add as moderator
      const userToAdd = await User.findOne({ username: req.body.username });
      if (!userToAdd) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      // Check if user is already a moderator
      if (community.moderators.includes(userToAdd._id)) {
        return res.status(400).json({ message: 'User is already a moderator' });
      }
      
      // Add user as moderator
      community.moderators.push(userToAdd._id);
      await community.save();
      
      // Populate moderator info before sending response
      await community.populate('moderators', 'username');
      
      res.json(community);
    } catch (error) {
      console.error('Add moderator error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Remove a moderator from a community
router.delete(
  '/:name/moderators/:userId',
  isAuthenticated,
  async (req, res) => {
    try {
      const community = await Community.findOne({ name: req.params.name.toLowerCase() });
      
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }
      
      // Check if user is the creator
      if (community.creator.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Only the community creator can remove moderators' });
      }
      
      // Check if trying to remove the creator
      if (community.creator.toString() === req.params.userId) {
        return res.status(400).json({ message: 'Cannot remove the community creator' });
      }
      
      // Remove user from moderators
      community.moderators = community.moderators.filter(
        mod => mod.toString() !== req.params.userId
      );
      
      await community.save();
      
      // Populate moderator info before sending response
      await community.populate('moderators', 'username');
      
      res.json(community);
    } catch (error) {
      console.error('Remove moderator error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Search communities
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.status(400).json({ message: 'Search query is required' });
    }
    
    const communities = await Community.find({
      name: { $regex: q, $options: 'i' }
    })
      .sort({ members: -1 })
      .limit(10)
      .lean();
    
    res.json(communities);
  } catch (error) {
    console.error('Search communities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
