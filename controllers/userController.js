const User = require('../models/User');

// Search users by username, email, or phone
const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;
    const currentUserId = req.user._id;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const searchRegex = new RegExp(query.trim(), 'i');

    const users = await User.find({
      $and: [
        { _id: { $ne: currentUserId } }, // Exclude current user
        {
          $or: [
            { username: searchRegex },
            { email: searchRegex },
            { phone: searchRegex }
          ]
        }
      ]
    })
    .select('username email phone avatar isOnline lastSeen')
    .limit(20); // Limit results

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Server error during search' });
  }
};

// Get user contacts
const getContacts = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('contacts', 'username email phone avatar isOnline lastSeen');
    res.json({ contacts: user.contacts });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Add user to contacts
const addContact = async (req, res) => {
  try {
    const { contactId } = req.body;
    const userId = req.user._id;

    // Validate contact exists
    const contact = await User.findById(contactId);
    if (!contact) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if already in contacts
    const user = await User.findById(userId);
    if (user.contacts.includes(contactId)) {
      return res.status(400).json({ error: 'User already in contacts' });
    }

    // Add to contacts
    user.contacts.push(contactId);
    await user.save();

    // Populate the added contact
    await user.populate('contacts', 'username email phone avatar isOnline lastSeen');

    res.json({
      message: 'Contact added successfully',
      contacts: user.contacts
    });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Remove user from contacts
const removeContact = async (req, res) => {
  try {
    const { contactId } = req.params;
    const userId = req.user._id;

    const user = await User.findById(userId);
    user.contacts = user.contacts.filter(id => id.toString() !== contactId);
    await user.save();

    await user.populate('contacts', 'username email phone avatar isOnline lastSeen');

    res.json({
      message: 'Contact removed successfully',
      contacts: user.contacts
    });
  } catch (error) {
    console.error('Remove contact error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Get user details by ID
const getUserById = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId).select('username email phone avatar isOnline lastSeen');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  searchUsers,
  getContacts,
  addContact,
  removeContact,
  getUserById
};