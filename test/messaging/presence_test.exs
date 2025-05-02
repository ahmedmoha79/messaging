defmodule Messaging.PresenceTest do
  use Messaging.ChannelCase, async: true
  alias Messaging.Presence

  describe "track_user/4" do
    test "tracks user presence" do
      pid = self()
      topic = "user:test-user"
      user_id = "test-user"
      meta = %{status: "online"}

      assert {:ok, _ref} = Presence.track_user(pid, topic, user_id, meta)
      assert %{^user_id => %{metas: [%{status: "online"}]}} = Presence.list(topic)
    end
  end

  describe "update_user/4" do
    test "updates user presence" do
      pid = self()
      topic = "user:test-user"
      user_id = "test-user"
      initial_meta = %{status: "online"}
      updated_meta = %{status: "away"}

      {:ok, _ref} = Presence.track_user(pid, topic, user_id, initial_meta)
      assert {:ok, _ref} = Presence.update_user(pid, topic, user_id, updated_meta)
      assert %{^user_id => %{metas: [%{status: "away"}]}} = Presence.list(topic)
    end
  end

  describe "list_users/1" do
    test "lists all users in a topic" do
      pid = self()
      topic = "user:test-topic"
      user1_id = "user1"
      user2_id = "user2"

      {:ok, _ref1} = Presence.track_user(pid, topic, user1_id, %{status: "online"})
      {:ok, _ref2} = Presence.track_user(pid, topic, user2_id, %{status: "online"})

      presence_list = Presence.list_users(topic)
      assert Map.has_key?(presence_list, user1_id)
      assert Map.has_key?(presence_list, user2_id)
    end

    test "returns empty map for topic with no users" do
      topic = "user:empty-topic"
      assert %{} = Presence.list_users(topic)
    end
  end

  describe "handle_metas/3" do
    test "handles user joins" do
      topic = "user:test-topic"
      user_id = "test-user"
      presence = %{metas: [%{status: "online"}]}
      joins = %{user_id => presence}
      leaves = %{}
      presences = %{}

      assert {:ok, _} = Presence.handle_metas(topic, %{joins: joins, leaves: leaves}, presences)
    end

    test "handles user leaves" do
      topic = "user:test-topic"
      user_id = "test-user"
      presence = %{metas: [%{status: "offline"}]}
      joins = %{}
      leaves = %{user_id => presence}
      presences = %{}

      assert {:ok, _} = Presence.handle_metas(topic, %{joins: joins, leaves: leaves}, presences)
    end
  end
end 